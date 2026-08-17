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
    let finalAssistantMessage = "";
    let resultText = "";
    let costUsd = 0;
    try {
      for await (const rawMessage of stream) {
        const message = rawMessage as unknown as SdkMessage;
        if (message.type === "assistant") {
          const text = assistantText(message);
          if (text.length > 0) finalAssistantMessage = text;
        }
        if (message.type === "result") {
          if (typeof message.total_cost_usd === "number") costUsd = message.total_cost_usd;
          if (typeof message.result === "string") resultText = message.result;
          if (message.is_error === true) {
            throw new AgentQueryError(resultText || `Claude Agent SDK result failed (${String(message.subtype)}).`, costUsd);
          }
        }
      }
    } finally {
      request.signal?.removeEventListener("abort", interrupt);
    }
    if (finalAssistantMessage.length === 0) finalAssistantMessage = resultText;
    if (finalAssistantMessage.length === 0) throw new Error("Claude Agent SDK returned no final assistant text.");
    return { finalAssistantMessage, costUsd };
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
    settingSources: [...request.settingSources],
    maxTurns: request.maxTurns,
    ...(request.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: request.maxBudgetUsd }),
    ...(request.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: request.pathToClaudeCodeExecutable }),
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
          if (typeof parsed.finalAssistantMessage !== "string") throw new Error("Stub output requires finalAssistantMessage.");
          resolveQuery({
            finalAssistantMessage: parsed.finalAssistantMessage,
            costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : 0,
          });
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

function assistantText(message: SdkMessage): string {
  const envelope = message.message;
  if (typeof envelope !== "object" || envelope === null) return "";
  const content = (envelope as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (
    typeof block === "object" && block !== null
      && (block as Record<string, unknown>).type === "text"
      && typeof (block as Record<string, unknown>).text === "string"
      ? [(block as Record<string, unknown>).text as string]
      : []
  )).join("\n");
}
