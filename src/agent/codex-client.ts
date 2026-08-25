import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { AgentQueryError, type AgentClient, type AgentQueryRequest, type AgentQueryResponse } from "./contract.js";

type CodexEvent = Record<string, unknown>;

export type CodexAgentClientOptions = Readonly<{
  codexPathOverride?: string;
  apiKey?: string;
}>;

export class CodexAgentClient implements AgentClient {
  /**
   * Codex's shell-command tool is disabled outright via `config.features.shell_tool = false`
   * (see #ensureCodex) — verified empirically against the real SDK that this removes the tool
   * entirely, the same never-offered guarantee ClaudeAgentClient's `tools: []` provides.
   * `supportsVaultTools = false` and the scratch-only workingDirectory below remain as
   * defense-in-depth: even if either were ever wired incorrectly, there is still no tool with
   * which to act on whatever the model was handed. See docs/DESIGN.md's per-backend scoping.
   */
  readonly supportsVaultTools = false;

  readonly #options: CodexAgentClientOptions;
  #codex: Codex | undefined;
  #scratchDir: Promise<string> | undefined;
  #cleanupRegistered = false;
  #resolvedScratchDir: string | undefined;

  constructor(options: CodexAgentClientOptions = {}) {
    this.#options = options;
  }

  async query(request: AgentQueryRequest): Promise<AgentQueryResponse> {
    if (request.signal?.aborted === true) throw new AgentQueryError("Agent query aborted.");
    const codex = this.#ensureCodex(request.systemPrompt);
    const workingDirectory = await this.#ensureScratchDir();
    const threadOptions = {
      // Always the scratch directory this client owns, never request.cwd: this backend is
      // never handed vault content (supportsVaultTools = false), and this field is not read
      // from `request` at all, so nothing can wire a vault path through here by accident.
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only" as const,
      approvalPolicy: "never" as const,
      // request.tools is deliberately never read into this object: Codex's own tool set is
      // controlled entirely by config.features.shell_tool (see #ensureCodex), not by a
      // per-request allowlist the way Claude's tools: [] is.
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

  #ensureCodex(systemPrompt: string): Codex {
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
      config: {
        base_instructions: systemPrompt,
        // Removes Codex's shell-command tool entirely — verified empirically against the real
        // SDK that a turn run this way reports it has no shell-command tool available at all.
        // This is what makes "the agent has no write tool" structural for this backend too,
        // matching ClaudeAgentClient's tools: [] guarantee shape rather than relying solely on
        // sandboxMode's after-the-fact write block. See docs/DESIGN.md's per-backend scoping.
        features: { shell_tool: false },
      },
    });
    return this.#codex;
  }

  #ensureScratchDir(): Promise<string> {
    this.#scratchDir ??= mkdtemp(join(tmpdir(), "shorthand-codex-")).then((dir) => {
      this.#resolvedScratchDir = dir;
      this.#registerCleanup();
      return dir;
    });
    return this.#scratchDir;
  }

  #registerCleanup(): void {
    if (this.#cleanupRegistered) return;
    this.#cleanupRegistered = true;
    // `exit` handlers must run synchronously, so async `rm` cannot be awaited here — this is
    // best-effort only, matching "reused for the life of the instance" in the design doc. A
    // hard kill (SIGKILL) skips it entirely, same as any other exit-handler cleanup in Node.
    process.once("exit", () => {
      if (this.#resolvedScratchDir !== undefined) {
        try { rmSync(this.#resolvedScratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });
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
