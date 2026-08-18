import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AgentQueryError, type AgentClient, type AgentQueryRequest, type AgentQueryResponse } from "./contract.js";

type SdkMessage = Record<string, unknown>;

export class ClaudeAgentClient implements AgentClient {
  async query(request: AgentQueryRequest): Promise<AgentQueryResponse> {
    if (request.signal?.aborted === true) throw new Error("Agent query aborted.");
    // Transcript and vault content are untrusted. The structural boundary is deliberate:
    // read-only/no tools here, schema validation in contract.ts, and no agent-owned writes.
    const options = buildClaudeAgentOptions(request);
    const stream = query({ prompt: request.prompt, options });
    const interrupt = () => { void stream.interrupt().catch(() => {}); };
    request.signal?.addEventListener("abort", interrupt, { once: true });
    let structuredOutput: unknown;
    let sessionId: string | undefined;
    let sawResult = false;
    try {
      for await (const rawMessage of stream) {
        const message = rawMessage as unknown as SdkMessage;
        // The session id is stable for the life of the stream: capture it off the first
        // message seen and never overwrite it on later messages.
        if (sessionId === undefined && typeof message.session_id === "string") sessionId = message.session_id;
        if (message.type !== "result") continue;
        // Only the result message carries the structured output. Under an output format a
        // completed turn ends on a tool_result carrier with no trailing assistant message,
        // so there is no assistant text left to harvest.
        sawResult = true;
        structuredOutput = message.structured_output;
        if (isStructuredOutputExhaustion(message)) continue;
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
    return { structuredOutput, sessionId };
  }
}

export function buildClaudeAgentOptions(request: AgentQueryRequest) {
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
    maxTurns: request.maxTurns,
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

/**
 * Exhausted schema retries arrive as an SDKResultError, not a success result, so the
 * generic is_error throw would swallow them. They are a rejection the contract loop can
 * still correct — its second attempt appends the validation error to the prompt, which is
 * feedback none of the SDK's internal retries ever saw — so they must not end the pass.
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
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((entry): entry is string => typeof entry === "string")
    : [];
  const detail = typeof message.result === "string" && message.result.length > 0
    ? message.result
    : errors.join("; ");
  return detail.length > 0 ? detail : `Claude Agent SDK result failed (${String(message.subtype)}).`;
}
