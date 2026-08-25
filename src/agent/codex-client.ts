import { rmSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { AgentQueryError, type AgentClient, type AgentQueryRequest, type AgentQueryResponse } from "./contract.js";

type CodexEvent = Record<string, unknown>;

export type CodexAgentClientOptions = Readonly<{
  codexPathOverride?: string;
  apiKey?: string;
  /**
   * Where the user's own Codex installation keeps `auth.json`. Injectable so tests can point
   * at a fixture: the auth-linking path is the security-relevant one, and covering it against
   * the developer's real `~/.codex` would mean reading — and hard-linking — live credentials
   * on every test run. Defaults to the ambient `CODEX_HOME`, then `~/.codex`.
   */
  ambientCodexHome?: string;
  /**
   * Model slug for the child. Optional because there is no defensible default to hardcode
   * here; see the pinning comment in #threadOptions for what an unset value inherits.
   */
  model?: string;
  /**
   * API endpoint for the child, re-supplying what the isolated CODEX_HOME threw away.
   * `openai_base_url` lives in the discarded `config.toml` like everything else, so a user
   * who pointed Codex at a compliance-mandated endpoint would otherwise have transcript
   * content sent to the public default instead, silently and with nothing to notice it by.
   * Only the endpoint can be restored this way: a full `model_providers.<id>` table (wire
   * API, custom headers, its own auth env var) has no typed SDK equivalent.
   */
  baseUrl?: string;
}>;

export class CodexAgentClient implements AgentClient {
  /**
   * Codex has built-in filesystem tools that cannot be allowlisted per turn. The client
   * therefore never receives vault context, always uses a scratch working directory, and gives
   * the child an isolated CODEX_HOME so operator MCP configuration cannot add a separate
   * unsandboxed path back into the vault. See docs/DESIGN.md's exact boundary.
   */
  readonly supportsVaultTools = false;

  readonly #options: CodexAgentClientOptions;
  #codex: Codex | undefined;
  #runtimeDirs: Promise<Readonly<{ root: string; workingDirectory: string; codexHome: string }>> | undefined;
  #cleanupRegistered = false;
  // Every root #ensureRuntimeDirs has ever mkdtemp'd for this client, not just the current
  // one: a build that fails and is retried (see the .catch below) leaves its root behind with
  // real mkdir'd state in it, and #runtimeDirs moves on to a fresh one on the next call. A
  // single "current root" field would make that first root invisible to both the exit handler
  // and dispose() the moment the retry's root replaced it, orphaning it — caught by the
  // temp-dir count still not reaching zero after adding dispose() and its own test coverage.
  #runtimeRoots: string[] = [];

  constructor(options: CodexAgentClientOptions = {}) {
    this.#options = options;
  }

  async query(request: AgentQueryRequest): Promise<AgentQueryResponse> {
    if (request.signal?.aborted === true) throw new AgentQueryError("Agent query aborted.");
    const { workingDirectory, codexHome } = await this.#ensureRuntimeDirs();
    const codex = this.#ensureCodex(request.systemPrompt, codexHome);
    const threadOptions = {
      // Always the scratch directory this client owns, never request.cwd: this backend is
      // never handed vault content (supportsVaultTools = false), and this field is not read
      // from `request` at all, so nothing can wire a vault path through here by accident.
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only" as const,
      approvalPolicy: "never" as const,
      // Web search is the one tool that reaches the internet without going through the OS
      // sandbox at all — the model asks the server for it — so `sandboxMode: "read-only"`
      // does nothing about it. Left unset it takes whatever the CLI defaults to, which is
      // the same mistake as leaving MCP to an inherited default: this agent reads untrusted
      // transcript text, and a search tool turns injected text into an outbound channel.
      // A user's own `web_search = "disabled"` cannot be relied on either, since the
      // isolated CODEX_HOME discards it along with the rest of config.toml.
      webSearchMode: "disabled" as const,
      // Inert while the sandbox is read-only: the SDK maps this to
      // `sandbox_workspace_write.network_access`, which only governs the workspace-write
      // sandbox. Pinned anyway so that widening sandboxMode later is a decision about writes
      // and not a silent grant of outbound network to a transcript-reading agent.
      networkAccessEnabled: false,
      // Pinned per thread because an isolated CODEX_HOME discards the whole of the user's
      // config.toml, not just its MCP table: a live isolated run was observed silently
      // switching to a different model with reasoning effort "none", since the config that
      // selected them never loaded. Passed through only when the caller supplies it — an
      // unset model inherits whatever the installed Codex CLI defaults to, which is
      // version-dependent and can change under a user who never changed anything.
      ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
      // request.tools is deliberately never read into this object: Codex has no per-thread
      // allowlist. The isolated CODEX_HOME is what actually narrows the tool surface; neither
      // it nor the exec pins turn the remaining built-ins into Claude's tools: [] shape.
    };
    const thread = typeof request.sessionId === "string" && request.sessionId.length > 0
      ? codex.resumeThread(request.sessionId, threadOptions)
      : codex.startThread(threadOptions);
    const turnOptions = {
      outputSchema: request.outputSchema,
      // The SDK forwards this straight into child_process.spawn's own `signal`, so this is real
      // cancellation, not cooperative — unlike ClaudeAgentClient, which has to call
      // stream.interrupt() from an abort listener because the Agent SDK has no signal option.
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    // runStreamed() resolves to { events: AsyncGenerator<ThreadEvent> } — the resolved value
    // is not itself async-iterable, unlike the Claude Agent SDK's query() stream.
    const { events } = await thread.runStreamed(request.prompt, turnOptions);
    let sessionId: string | undefined;
    let structuredOutput: unknown;
    let diagnostics: string[] = [];
    let sawAgentMessage = false;
    for await (const rawEvent of events) {
      const event = rawEvent as CodexEvent;
      // The session id is stable for the life of the stream: capture it off the first
      // thread.started message seen and never overwrite it on later messages.
      if (sessionId === undefined && event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
      }
      // TurnCompletedEvent carries only token usage, not the answer. The answer is an
      // item.completed event wrapping an agent_message item; other item types (shell exec,
      // file changes, MCP tool calls) can appear in the same stream and must be ignored here.
      if (event.type === "item.completed") {
        const item = event.item as CodexEvent | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          sawAgentMessage = true;
          // outputSchema is meant to be hard-enforced at the API level, so `text` should
          // always be valid JSON here — but "should always be" is exactly what this
          // project's own "do not assume, empirically test" principle distrusts. A parse
          // failure is treated as an invalid pass (structuredOutput left undefined,
          // diagnostics carried for the corrective retry in queryForSections), the same way
          // ClaudeAgentClient's schema-exhaustion path is — not thrown, which would skip the
          // corrective retry entirely.
          try {
            structuredOutput = JSON.parse(item.text);
          } catch {
            diagnostics = [`Codex agent_message text was not valid JSON: ${item.text.slice(0, 200)}`];
          }
        }
      }
      if (event.type === "turn.failed" || event.type === "error") {
        throw new AgentQueryError(turnFailureMessage(event));
      }
    }
    if (sessionId === undefined) throw new Error("Codex SDK returned no thread id.");
    if (!sawAgentMessage) throw new AgentQueryError("Codex SDK stream ended without an agent message.");
    return { structuredOutput, sessionId, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
  }

  #ensureCodex(systemPrompt: string, codexHome: string): Codex {
    // Lazy: CodexOptions.config (which carries base_instructions, replacing Codex's default
    // system prompt — see docs/superpowers/specs/2026-08-25-codex-agent-backend-design.md) is
    // constructor-level, not per-thread, so the Codex instance can't be built until the first
    // call's systemPrompt is known. Built once and reused after that, which relies on
    // request.systemPrompt being identical across every call on one client instance — already
    // true today (EnhanceRunnerOptions.guidance is fixed at construction — see AGENTS.md "the
    // enhancement prompt is split, deliberately"). If that ever stops being true, this
    // silently keeps serving the FIRST call's instructions to every later call.
    this.#codex ??= new Codex({
      ...(this.#options.codexPathOverride === undefined ? {} : { codexPathOverride: this.#options.codexPathOverride }),
      ...(this.#options.apiKey === undefined ? {} : { apiKey: this.#options.apiKey }),
      ...(this.#options.baseUrl === undefined ? {} : { baseUrl: this.#options.baseUrl }),
      // Codex merges `--config mcp_servers={}` into the ambient table, so named child servers
      // survive that override and still connect. CODEX_HOME changes the config discovery root;
      // passing it through CodexOptions.env is intentional because the SDK then replaces the
      // child's environment instead of implicitly inheriting the operator's original value.
      env: isolatedCodexEnvironment(codexHome),
      config: {
        base_instructions: systemPrompt,
        // Defence in depth, explicitly NOT a boundary. A turn run this way does report that it
        // has no shell-command tool, but that proves nothing about what it can execute: with
        // both of these disabled under sandboxMode "read-only", a live probe still ran a shell
        // command by calling out to an operator MCP server (`node_repl`), because Codex does
        // not apply sandboxMode to MCP tools at all. The isolated CODEX_HOME above is the
        // boundary that closes that path; these flags only remove the direct routes.
        //
        // Both are needed, and both default to enabled: `codex features list` reports
        // shell_tool and unified_exec as separate stable flags, so pinning shell_tool alone
        // leaves a second exec tool switched on and makes the probe above describe a stricter
        // configuration than the one this code creates.
        features: { shell_tool: false, unified_exec: false },
      },
    });
    return this.#codex;
  }

  #ensureRuntimeDirs(): Promise<Readonly<{ root: string; workingDirectory: string; codexHome: string }>> {
    this.#runtimeDirs ??= mkdtemp(join(tmpdir(), "shorthand-codex-"))
      .then(async (root) => {
        // Recorded and registered the moment the root exists, before any fallible auth work
        // below: a probe proved that registering cleanup only after a successful auth link
        // left two compounding failures when the link threw instead — the root was never
        // handed to the exit handler, so it leaked forever, and the rejected promise stayed
        // cached in #runtimeDirs (see the .catch below), so every later query() failed the
        // same way permanently. Neither depends on the auth step succeeding.
        this.#runtimeRoots.push(root);
        this.#registerCleanup();
        const workingDirectory = join(root, "work");
        const codexHome = join(root, "home");
        await Promise.all([mkdir(workingDirectory), mkdir(codexHome)]);
        if (this.#options.apiKey === undefined) {
          await linkAmbientCodexAuth(resolveAmbientCodexHome(this.#options.ambientCodexHome), codexHome);
        }
        return { root, workingDirectory, codexHome };
      })
      .catch((error: unknown) => {
        // A rejected promise cached by the `??=` above would fail every subsequent query()
        // identically forever, even for a transient failure (a momentary permission error on
        // the auth link, a full disk on mkdir) that would very plausibly succeed on retry.
        // Clearing the cache lets the next #ensureRuntimeDirs() build a fresh root instead of
        // replaying a dead promise. The root already pushed to #runtimeRoots above is
        // deliberately left there: it may hold partial state (mkdir'd work/home dirs, maybe a
        // copied auth.json), and #registerCleanup/#runtimeRoots — not this field — are what
        // will eventually clean it up, whether or not the retry succeeds.
        this.#runtimeDirs = undefined;
        throw error;
      });
    return this.#runtimeDirs;
  }

  #registerCleanup(): void {
    if (this.#cleanupRegistered) return;
    this.#cleanupRegistered = true;
    // `exit` handlers must run synchronously, so async `rm` cannot be awaited here — this is
    // best-effort only, matching "reused for the life of the instance" in the design doc. A
    // hard kill (SIGKILL) skips it entirely, same as any other exit-handler cleanup in Node.
    // Registered before the auth step runs (see #ensureRuntimeDirs), so this is also what
    // removes a copy-fallback duplicate of auth.json on any graceful exit, including one that
    // races a rejected auth link — only a SIGKILL leaves that duplicate on disk. Reads
    // #runtimeRoots live at exit time (not a snapshot taken here), so every root the client
    // accumulated by then — including ones from a failed attempt that was retried — is swept,
    // not just whichever one was current when this handler was registered.
    process.once("exit", () => {
      for (const root of this.#runtimeRoots) {
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });
  }

  /**
   * Removes every runtime root this client has ever created (scratch working directories,
   * isolated CODEX_HOMEs, and any auth.json copies inside them) without waiting for process
   * exit. The `exit` handler above is a production backstop, not a substitute: it never fires
   * under bun's test runner, so without this, every test that calls query() leaks a
   * "shorthand-codex-*" directory under the OS temp dir for the life of the machine, not just
   * the test run. A no-op if query() was never called (no root was ever created). Clears
   * #runtimeDirs too, so a query() after dispose() rebuilds rather than reusing handles into
   * directories this just removed.
   */
  async dispose(): Promise<void> {
    if (this.#runtimeDirs !== undefined) {
      // Wait out an in-flight or rejected build first: removing a root out from under a
      // concurrent mkdir/link would race the very directory it is creating.
      await this.#runtimeDirs.catch(() => undefined);
      this.#runtimeDirs = undefined;
    }
    const roots = this.#runtimeRoots.splice(0);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

function isolatedCodexEnvironment(codexHome: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "CODEX_HOME" && value !== undefined) environment[key] = value;
  }
  environment.CODEX_HOME = codexHome;
  return environment;
}

/**
 * Where the user's own Codex login lives. Exported for the tests that pin this precedence
 * without opening any of the paths, and deliberately kept out of `src/index.ts`: consumers
 * configure this through `CodexAgentClientOptions.ambientCodexHome`, not by resolving it
 * themselves.
 */
export function resolveAmbientCodexHome(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (override !== undefined && override.length > 0) return override;
  // Windows environment lookups are case-insensitive, so `codex_home` set in a shell profile
  // reaches the child as CODEX_HOME and must be found here too; Node's process.env exposes
  // whatever casing was set.
  const configured = Object.entries(environment)
    .find(([key, value]) => key.toUpperCase() === "CODEX_HOME" && value !== undefined && value.length > 0)?.[1];
  return configured ?? join(homedir(), ".codex");
}

async function linkAmbientCodexAuth(ambientHome: string, isolatedHome: string): Promise<void> {
  // Authentication and configuration share one discovery root: CODEX_HOME is the only path
  // Codex reads either from, so isolating config necessarily orphans auth and the login has to
  // be brought across deliberately. Bringing across auth.json alone leaves config.toml, skills
  // and MCP servers behind, which is the point of the isolated home.
  const target = join(ambientHome, "auth.json");
  const destination = join(isolatedHome, "auth.json");
  let source: string;
  try {
    // fs.link operates on the directory entry, not the file it points to: it does not follow
    // symlinks. A dotfile-managed `auth.json -> ../dotfiles/codex-auth.json` (a relative
    // target, the ordinary shape for a dotfiles repo) would otherwise get hardlinked as a
    // second symlink with the same relative target, landing in a different directory
    // (isolatedHome, not ambientHome) where that relative path does not resolve — Codex then
    // reports "not logged in" with nothing to explain why. realpath resolves through any such
    // symlink up front, so link() below always sees a real file. copyFile does not have this
    // problem (it follows symlinks itself), which is why the same input previously worked
    // cross-volume and failed same-volume.
    source = await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // No ambient auth.json is normal, not a fault: the user may be supplying an API key through
    // the environment, or may never have run `codex login`. The CLI's own unauthenticated
    // failure says so far better than anything raised from here. ENOTDIR lands here too: an
    // ambient CODEX_HOME that itself resolves to a file (not a directory) makes `join(ambientHome,
    // "auth.json")` invalid in the same "nothing to log in with" way, not a fault worth crashing
    // the backend over.
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  try {
    // A second name for the same file, not a second copy of it. Two consequences, both wanted
    // as long as this holds: live OAuth credentials are never duplicated on disk, and a token
    // Codex rotates mid-run is written through to the user's own auth.json instead of dying
    // with the scratch directory — leaving the user logged out of a CLI they never touched.
    // This rests on Codex rewriting auth.json in place rather than writing a temp file and
    // renaming over it, which would break the link silently. Verified against the real CLI on
    // the `codex login --with-api-key` write path only; the OAuth refresh write path was not
    // exercised directly, so treat the write-through property as unconfirmed there until it is.
    await link(source, destination);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Hard links need both names on one volume (EXDEV) and, on some filesystems and mount
    // options, the privilege to create them (EPERM/EACCES). ENOTSUP/EOPNOTSUPP/EINVAL cover
    // volumes that cannot hardlink at all regardless of privilege — exFAT, FAT32, and some
    // SMB/FUSE mounts — where the copy fallback below still works. Anything else is a real
    // fault and must not be papered over by silently doing something weaker.
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES"
      && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EINVAL") throw error;
  }
  try {
    // This fallback re-introduces exactly what the link avoids: a duplicate of live credentials
    // on disk, and a rotated token discarded with the scratch directory. It is reached when the
    // OS temp directory and the user's home sit on different volumes, which is ordinary on
    // Windows and on Linux with a tmpfs /tmp. The duplicate is removed by the best-effort exit
    // cleanup in #registerCleanup, which a SIGKILL skips.
    await copyFile(source, destination);
  } catch (error) {
    // Not dead code: realpath above already proved `source` existed, but a concurrent `codex
    // login` or `codex logout` can unlink it between that check and this copy. Treated the same
    // as the ENOENT case above — a benign timing loss, not a fault to crash the backend over.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function turnFailureMessage(event: CodexEvent): string {
  const error = event.error;
  if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return typeof event.message === "string" ? event.message : `Codex SDK turn failed (${String(event.type)}).`;
}

export function detectCodexExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = override ?? environment.SHORTHAND_CODEX_EXE;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return undefined;
}

/**
 * Same override/environment-variable precedence as {@link detectCodexExecutable}, without the
 * path resolution: a model slug is not a filesystem path. Exists so the CLI can set
 * `CodexAgentClientOptions.model` — the option was previously reachable only by embedding core
 * directly, since neither a flag nor an env var wired it through `bin/shorthand-notes.ts`.
 */
export function resolveCodexModel(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = override ?? environment.SHORTHAND_CODEX_MODEL;
  return configured !== undefined && configured.length > 0 ? configured : undefined;
}

/**
 * Same override/environment-variable precedence as {@link detectCodexExecutable}, for
 * `CodexAgentClientOptions.baseUrl`. The isolated CODEX_HOME discards the ambient config.toml
 * entirely, so a compliance-mandated endpoint set there is otherwise lost without any CLI way
 * to re-supply it — see the `baseUrl` option's own doc comment for why only the endpoint, not
 * the rest of `model_providers`, can be restored this way.
 */
export function resolveCodexBaseUrl(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = override ?? environment.SHORTHAND_CODEX_BASE_URL;
  return configured !== undefined && configured.length > 0 ? configured : undefined;
}
