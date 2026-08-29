import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AccountInfo, CanUseTool, EffortLevel, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { deleteSession, query } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentCatalogError,
  CATALOG_TIMEOUT_MS,
  type AgentCatalog,
  type AgentModel,
  type CatalogFailureReason,
} from "./catalog.js";
import { AgentQueryError, type AgentClient, type AgentQueryRequest, type AgentQueryResponse } from "./contract.js";

type SdkMessage = Record<string, unknown>;

/**
 * The known-good effort levels for the npm SDK version this package is built against. Kept
 * as the synchronous type-guard for validating a stored setting when no catalog can be
 * awaited; it is not the type of `ClaudeAgentClientOptions.effort` (see that field's comment
 * and catalog.ts's `AgentModel.efforts` for why).
 */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
export type ClaudeEffort = typeof CLAUDE_EFFORT_LEVELS[number];

export type ClaudeAgentClientOptions = Readonly<{
  model?: string;
  /**
   * Plain `string`, not `ClaudeEffort`: the value offered to a caller comes from
   * `AgentModel.efforts` in catalog.ts, read from the live CLI at runtime, which can list an
   * effort the pinned npm SDK's `EffortLevel` union does not yet know about. Narrowing this to
   * `ClaudeEffort` would make a runtime-valid, catalog-offered choice a type error. See the
   * cast onto the SDK's own `effort?: EffortLevel` in `buildClaudeAgentOptions` for where that
   * gap is closed instead.
   */
  effort?: string;
  /** Keep the SDK's local transcript after disposal. Defaults to false. */
  retainSessionHistory?: boolean;
}>;

export class ClaudeAgentClient implements AgentClient {
  readonly #options: ClaudeAgentClientOptions;
  readonly #sessions = new Map<string, string | undefined>();
  #disposePromise: Promise<void> | undefined;

  constructor(options: ClaudeAgentClientOptions = {}) {
    this.#options = options;
  }

  async query(request: AgentQueryRequest): Promise<AgentQueryResponse> {
    if (request.signal?.aborted === true) throw new Error("Agent query aborted.");
    // Transcript and vault content are untrusted. The structural boundary is deliberate:
    // read-only/no tools here, schema validation in contract.ts, and no agent-owned writes.
    const options = buildClaudeAgentOptions(request, this.#options);
    const stream = query({ prompt: request.prompt, options });
    const interrupt = () => { void stream.interrupt().catch(() => {}); };
    request.signal?.addEventListener("abort", interrupt, { once: true });
    let structuredOutput: unknown;
    let sessionId: string | undefined;
    let sawResult = false;
    let diagnostics: readonly string[] = [];
    try {
      for await (const rawMessage of stream) {
        const message = rawMessage as unknown as SdkMessage;
        // The session id is stable for the life of the stream: capture it off the first
        // message seen and never overwrite it on later messages.
        if (sessionId === undefined && typeof message.session_id === "string") {
          sessionId = message.session_id;
          // Capture this before the turn can fail or abort. The runner may never adopt a late
          // first-turn id, but the SDK has already persisted that transcript and still owns it.
          this.#sessions.set(sessionId, request.cwd);
        }
        if (message.type !== "result") continue;
        // Only the result message carries the structured output. Under an output format a
        // completed turn ends on a tool_result carrier with no trailing assistant message,
        // so there is no assistant text left to harvest.
        sawResult = true;
        structuredOutput = message.structured_output;
        if (isStructuredOutputExhaustion(message)) {
          // Keep the diagnostics rather than dropping them with the throw below: they are
          // the only account of what the model got wrong, and the corrective attempt is
          // where they earn their keep.
          diagnostics = resultErrors(message);
          continue;
        }
        if (message.is_error === true) throw new AgentQueryError(resultFailureMessage(message));
      }
    } finally {
      request.signal?.removeEventListener("abort", interrupt);
    }
    // Every SDK message type carries session_id, so this only fires for a stream that
    // produced no messages at all.
    if (sessionId === undefined) throw new Error("Claude Agent SDK returned no session id.");
    // Absent structured output only means the model failed the schema if a result message
    // said so. A stream that ended without one produced no answer at all — an abort, a killed
    // subprocess, or a CLI old enough to ignore `outputFormat` (the executable is resolved
    // from the user's own install and versions independently of the npm SDK). Returning
    // `undefined` here would hand the contract loop a value it cannot tell apart from
    // exhaustion, so every such pass would be logged and reported as bad model output.
    if (!sawResult) throw new AgentQueryError("Claude Agent SDK stream ended without a result message.");
    return { structuredOutput, sessionId, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeSessions().finally(() => { this.#disposePromise = undefined; });
    return this.#disposePromise;
  }

  async #disposeSessions(): Promise<void> {
    if (this.#options.retainSessionHistory === true) return;
    const sessions = [...this.#sessions];
    const outcomes = await Promise.allSettled(sessions.map(async ([sessionId, cwd]) => {
      await deleteSession(sessionId, cwd === undefined ? undefined : { dir: cwd });
      this.#sessions.delete(sessionId);
    }));
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to delete ${failures.length} Claude session transcript(s).`);
    }
  }
}

export function buildClaudeAgentOptions(
  request: AgentQueryRequest,
  clientOptions: Pick<ClaudeAgentClientOptions, "model" | "effort"> = {},
) {
  const { cwd } = request;
  return {
    // No cwd means no filesystem context was offered. Inheriting process.cwd() here
    // would hand the subprocess an arbitrary directory (an app install dir, or
    // System32 from a Startup shortcut) as its confinement root and its CLAUDE.md
    // discovery origin — memory discovery walks UP from cwd and settingSources: []
    // does not cover it. Omit it, and deny every tool outright.
    ...(cwd === undefined ? {} : { cwd }),
    tools: [...request.tools],
    // Deliberately NO `allowedTools`: bare tool names there auto-approve a call before
    // canUseTool is consulted (the SDK emits CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), which would
    // silently disable vault path confinement. `tools` still bounds availability; every
    // actual call must fall through to the guard below.
    permissionMode: "default" as const,
    canUseTool: cwd === undefined ? denyAllToolGuard() : createVaultToolGuard(cwd, request.tools),
    systemPrompt: request.systemPrompt,
    outputFormat: { type: "json_schema" as const, schema: request.outputSchema },
    settingSources: [...request.settingSources],
    // settingSources: [] excludes user/project/local settings, but strictMcpConfig is the
    // SDK's dedicated boundary for every other on-disk MCP source (including .mcp.json,
    // plugins, and agent frontmatter). An explicit empty map leaves no permitted server.
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: request.maxTurns,
    ...(clientOptions.model === undefined ? {} : { model: clientOptions.model }),
    // Cast, not a narrowed type on ClaudeAgentClientOptions.effort: the SDK's own `effort`
    // parameter is typed `EffortLevel`, a snapshot of what the pinned npm SDK version knew
    // about when it was published. `clientOptions.effort` can be a value the live CLI reported
    // through catalog.ts's AgentModel.efforts that this snapshot has not caught up to yet — the
    // CLI is a separately-versioned binary resolved from PATH (docs/DESIGN.md). Rejecting it
    // here (by keeping the field typed `EffortLevel`) would make a value the CLI just told the
    // caller it accepts unusable; passing it through and letting the CLI itself reject an
    // actually-bad value trades a compile-time refusal for a runtime one the existing
    // is_error/AgentQueryError path already surfaces, which is the smaller failure mode.
    ...(clientOptions.effort === undefined ? {} : { effort: clientOptions.effort as EffortLevel }),
    ...(request.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: request.pathToClaudeCodeExecutable }),
    // A caller could in principle pass sessionId: "" (see ExecutableAgentStub's fallback
    // below, though nothing wires that into a real query today) — only a non-empty
    // string is a real, resumable session id, and resume: "" would be an empty
    // --resume flag to the CLI.
    ...(typeof request.sessionId === "string" && request.sessionId.length > 0 ? { resume: request.sessionId } : {}),
  };
}

/**
 * The guard for a pass with no filesystem context: nothing is confinable, so
 * nothing is permitted. There is no root to compare a path against, and a pass
 * that reaches here must succeed from its bounded prompt alone.
 */
export function denyAllToolGuard(): CanUseTool {
  return async (toolName) => ({
    behavior: "deny",
    message: `Tool ${toolName} is not permitted: this pass has no filesystem context.`,
  });
}

export function createVaultToolGuard(vaultRoot: string, allowedTools: readonly string[]): CanUseTool {
  const allowed = new Set(allowedTools);
  const rootPromise = realpath(resolve(vaultRoot));
  return async (toolName, input) => {
    if (!allowed.has(toolName)) return { behavior: "deny", message: `Tool ${toolName} is not enabled for this pass.` };
    if (toolName !== "Read" && toolName !== "Glob" && toolName !== "Grep") {
      return { behavior: "deny", message: `Tool ${toolName} is not permitted.` };
    }
    const requested = toolPath(toolName, input);
    if (requested === undefined) {
      if (toolName === "Read") return { behavior: "deny", message: "Read requires a vault-confined file_path." };
      return { behavior: "allow", updatedInput: input };
    }
    const root = await rootPromise;
    const lexicalRoot = resolve(vaultRoot);
    const lexicalTarget = resolve(lexicalRoot, requested);
    if (!isConfined(lexicalRoot, lexicalTarget)) return { behavior: "deny", message: "Tool path is outside the vault." };
    const resolvedTarget = await realpathWithMissingTail(lexicalTarget);
    if (!isConfined(root, resolvedTarget)) return { behavior: "deny", message: "Tool path resolves outside the vault." };
    return { behavior: "allow", updatedInput: input };
  };
}

function toolPath(toolName: string, input: Record<string, unknown>): string | undefined {
  const candidate = toolName === "Read"
    ? input.file_path
    : toolName === "Glob" && typeof input.path !== "string" && typeof input.pattern === "string" && (isAbsolute(input.pattern) || input.pattern.startsWith(".."))
      ? input.pattern
      : input.path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

async function realpathWithMissingTail(target: string): Promise<string> {
  let existing = target;
  const missing: string[] = [];
  while (true) {
    try {
      await stat(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`Cannot resolve tool path ${target}.`);
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  return resolve(await realpath(existing), ...missing);
}

function isConfined(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export class ExecutableAgentStub implements AgentClient {
  readonly #script: string;

  constructor(script: string) {
    this.#script = resolve(script);
  }

  query(request: AgentQueryRequest): Promise<AgentQueryResponse> {
    if (request.signal?.aborted === true) return Promise.reject(new Error("Agent stub aborted."));
    return new Promise((resolveQuery, rejectQuery) => {
      const child = spawn(process.execPath, [this.#script], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const abort = () => child.kill();
      request.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", rejectQuery);
      child.once("close", (code) => {
        request.signal?.removeEventListener("abort", abort);
        if (request.signal?.aborted === true) return rejectQuery(new Error("Agent stub aborted."));
        if (code !== 0) return rejectQuery(new Error(`Agent stub exited ${code}: ${stderr.trim()}`));
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          // Presence, not type: `structuredOutput` is deliberately `unknown` — a fixture may
          // legitimately emit `null` or omit the sections to exercise a rejection — but a
          // fixture that leaves the key out entirely is broken, not modelling a failure.
          if (!("structuredOutput" in parsed)) throw new Error("Stub output requires structuredOutput.");
          // Stubs are hand-written fixtures that predate session ids; falling back to an
          // empty string keeps the stub JSON contract simple rather than forcing every
          // fixture to invent one.
          const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
          resolveQuery({ structuredOutput: parsed.structuredOutput, sessionId });
        } catch (error) {
          rejectQuery(new Error(`Invalid agent stub JSON: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

export function detectClaudeExecutable(override?: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = override ?? environment.SHORTHAND_CLAUDE_EXE;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  if (process.platform === "win32") {
    const candidate = join(environment.USERPROFILE ?? homedir(), ".local", "bin", "claude.exe");
    if (existsSync(candidate)) return candidate;
  }
  // Leaving this undefined delegates PATH/platform auto-detection to the Agent SDK.
  return undefined;
}

export type ListClaudeModelsOptions = Readonly<{
  /** Same override precedence as {@link detectClaudeExecutable}: wins over SHORTHAND_CLAUDE_EXE and the platform default. */
  executableOverride?: string;
}>;

/**
 * Reads the Claude Agent SDK's model catalog without running a turn. `supportedModels()` and
 * `accountInfo()` both read the cached `initialize` response the handshake already produced
 * (measured ~1.5s, zero tokens spent) — nothing here iterates the prompt stream or sends one.
 * See docs/AGENT-SESSION-PRIVACY.md § "Reading the model catalog" for why this is the one Claude
 * probe allowed to run outside a real query.
 */
export async function listClaudeModels(options: ListClaudeModelsOptions = {}): Promise<AgentCatalog> {
  const executable = detectClaudeExecutable(options.executableOverride);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Declared outside the try so the `finally` below can still reach it, but left unassigned
  // until query() actually runs inside the try: query() itself can throw (a construction
  // failure, not a stream failure), and that throw must go through the same catch/classify
  // path below rather than escaping the function before `finally` ever runs.
  let stream: ReturnType<typeof query> | undefined;
  try {
    stream = query({
      prompt: "",
      options: {
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
      },
    });
    // The timeout itself is an AgentCatalogError so the catch block below can pass it straight
    // through: only a raw SDK failure (a spawn that never reached the handshake) still needs
    // reclassifying there.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AgentCatalogError("timeout", `Claude model catalog fetch exceeded ${CATALOG_TIMEOUT_MS}ms.`)),
        CATALOG_TIMEOUT_MS,
      );
    });
    const [models, account] = await Promise.race([fetchClaudeCatalogData(stream), timeout]);
    return toClaudeCatalog(models, account);
  } catch (error) {
    if (error instanceof AgentCatalogError) throw error;
    throw classifyClaudeCatalogFailure(error);
  } finally {
    clearTimeout(timer);
    // Closed on every path that produced a stream, including the timeout race: `close()`
    // terminates the child process, and a catalog probe that leaked a subprocess on a slow
    // machine would trade a cosmetic "still loading" row for a real resource leak nobody
    // notices until later. `stream` can still be undefined here if query() itself threw.
    //
    // Guarded rather than bare: a throw from close() would replace whatever the try/catch
    // above already decided to return or raise, trading the real outcome for a cleanup
    // failure the caller could not act on. sdk.d.ts makes no promise close() cannot throw, so
    // this is not assumed away even though no such path is known in this SDK build.
    try {
      stream?.close();
    } catch {
      // Deliberately swallowed — see comment above.
    }
  }
}

/**
 * Sequential, not `Promise.all`: this is the exact shape given as already verified against the
 * running SDK, and both calls are cheap cache reads rather than round trips worth parallelizing.
 */
async function fetchClaudeCatalogData(
  stream: ReturnType<typeof query>,
): Promise<readonly [ModelInfo[], AccountInfo]> {
  const models = await stream.supportedModels();
  const account = await stream.accountInfo();
  return [models, account];
}

/**
 * Pure mapping from what the SDK returned to the shape catalog.ts defines, split out from
 * listClaudeModels() so it can be exercised against test/fixtures/claude-model-catalog.json
 * without spawning a subprocess.
 */
export function toClaudeCatalog(models: readonly ModelInfo[], account: AccountInfo): AgentCatalog {
  // Malformed, not merely empty-by-policy: a real signed-out account still returns Sonnet and
  // Haiku (see catalog.ts's AgentCatalog.signedIn doc), so an empty or non-array response here
  // means the SDK's contract broke, not that nobody is signed in.
  if (!Array.isArray(models) || models.length === 0) {
    throw new AgentCatalogError("protocol", "Claude Agent SDK returned no models.");
  }
  const mapped = models.map((model, index) => toAgentModel(model, index));
  const rawEmail = typeof account === "object" && account !== null ? account.email : undefined;
  // "" is falsy but !== undefined: treating it as a named account would show the user a blank
  // identity instead of reporting them signed out. sdk.d.ts types `email` as a plain optional
  // string with no stated guarantee it is non-empty when present, so this is not assumed away.
  const email = typeof rawEmail === "string" && rawEmail.length > 0 ? rawEmail : undefined;
  return {
    models: mapped,
    // Neither backend fails when signed out; the only reliable signal is whether the SDK
    // named an account at all (see catalog.ts's AgentCatalog.signedIn comment).
    signedIn: email !== undefined,
    ...(email === undefined ? {} : { account: email }),
  };
}

function toAgentModel(model: ModelInfo, index: number): AgentModel {
  // `value` is checked on its own, before displayName/description, so a failure on those two
  // can name the model in its message rather than just its index — value is what a human
  // debugging a malformed catalog row would otherwise have to go fetch the raw response for.
  if (typeof model !== "object" || model === null || typeof model.value !== "string" || model.value.length === 0) {
    throw new AgentCatalogError("protocol", `Claude Agent SDK model at index ${index} is missing a valid value.`);
  }
  if (typeof model.displayName !== "string" || typeof model.description !== "string") {
    throw new AgentCatalogError(
      "protocol",
      `Claude Agent SDK model "${model.value}" at index ${index} is missing a required field.`,
    );
  }
  // supportsEffort and supportedEffortLevels are two independent optional fields on ModelInfo
  // (sdk.d.ts documents no invariant linking them). A row with supportsEffort: true but no
  // supportedEffortLevels would otherwise map silently to efforts: [], which AgentModel.efforts
  // defines as "this model takes no effort setting at all" — the opposite of what the row just
  // asserted. Treated as a protocol error rather than a silent default, consistent with how
  // strict this function already is about displayName/description.
  if (model.supportsEffort === true && !Array.isArray(model.supportedEffortLevels)) {
    throw new AgentCatalogError(
      "protocol",
      `Claude Agent SDK model "${model.value}" at index ${index} supports effort levels but reported none.`,
    );
  }
  return {
    id: model.value,
    displayName: model.displayName,
    description: model.description,
    // Absent, not defaulted to empty-and-forgotten: Haiku reports neither `supportsEffort` nor
    // `supportedEffortLevels` at all, and that silence is the real "this model takes no effort
    // setting" answer a caller must act on (see catalog.ts's AgentModel.efforts doc) — not a
    // gap to paper over. The contradictory case (supportsEffort: true, no levels) is rejected
    // above rather than reaching this line.
    efforts: Array.isArray(model.supportedEffortLevels) ? [...model.supportedEffortLevels] : [],
    // ModelInfo carries no per-model default-effort field, so there is nothing here to report;
    // defaultEffort is left unset rather than invented.
  };
}

/**
 * Classifies an SDK failure that happened before any catalog data arrived: the subprocess could
 * not be spawned, or died before the handshake completed. Reading ProcessTransport's own error
 * handling in the installed `@anthropic-ai/claude-agent-sdk/sdk.mjs` shows the SDK forwards the
 * child_process `"error"` event's `code` onto whichever Error it ultimately throws or rejects
 * with, so a bare `ENOENT` here means exactly what it means for any spawn: no file at the
 * resolved executable path.
 *
 * That is undocumented SDK behavior — `sdk.d.ts` promises nothing about `.code` surviving onto
 * the rejection — so this function is exported and the tests in
 * test/agent-catalog-claude.test.ts pin the `{code:"ENOENT"} -> executable-not-found` mapping
 * down explicitly. Without that test, an SDK bump that stopped forwarding `.code` would degrade
 * every "executable not found" case to the more generic "spawn-failed" instruction silently:
 * no type error, no failing test, just a wrong message next time someone hits it.
 *
 * The SDK's own internal classifier treats a broader errno set (ENOENT, EACCES, EPERM, ENOTDIR,
 * ELOOP, ENAMETOOLONG, EROFS) as launch-path failures, but `catalog.ts` exposes only two reasons
 * at this stage and is not this file's to extend. Collapsing everything but ENOENT — including
 * EACCES — into "spawn-failed" is therefore a deliberate simplification stated here, not an
 * oversight: those cases still get a reason, just the less specific one.
 */
export function classifyClaudeCatalogFailure(error: unknown): AgentCatalogError {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  const reason: CatalogFailureReason = code === "ENOENT" ? "executable-not-found" : "spawn-failed";
  const message = error instanceof Error ? error.message : String(error);
  return new AgentCatalogError(reason, `Failed to fetch the Claude model catalog: ${message}`, { cause: error });
}

/**
 * Exhausted schema retries arrive as an SDKResultError, not a success result, so the
 * generic is_error throw would swallow them. They are a rejection the contract loop can
 * still correct, so they must not end the pass: its second attempt is a fresh turn that
 * re-sends the whole prompt — sections, transcript, and user notes — with the SDK's own
 * `errors` appended, rather than another schema-constrained retry inside a turn that has
 * already gone wrong. Whether the SDK's internal retries saw those same errors is not
 * observable from here, so the retry is not claimed to tell the model something new; what
 * it reliably buys is a clean turn that states the failure in the prompt.
 */
function isStructuredOutputExhaustion(message: SdkMessage): boolean {
  return message.subtype === "error_max_structured_output_retries"
    || message.terminal_reason === "structured_output_retry_exhausted";
}

/**
 * SDKResultError carries no `result` string; its diagnostics are in `errors`. Reading only
 * `result` would report every real failure as the bare generic message below.
 */
function resultFailureMessage(message: SdkMessage): string {
  const detail = typeof message.result === "string" && message.result.length > 0
    ? message.result
    : resultErrors(message).join("; ");
  return detail.length > 0 ? detail : `Claude Agent SDK result failed (${String(message.subtype)}).`;
}

/**
 * `errors` is declared `string[]` on SDKResultError but is absent from SDKResultSuccess and
 * may legitimately be empty, so neither its presence nor its contents can be assumed.
 */
function resultErrors(message: SdkMessage): readonly string[] {
  return Array.isArray(message.errors)
    ? message.errors.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}
