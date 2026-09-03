import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { PROTOCOL_VERSION, type Stream } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import {
  AgentQueryError,
  type AgentClient,
  type AgentQueryRequest,
  type AgentQueryResponse,
} from "./contract.js";
import { Utf8LineReader } from "../ndjson.js";

export const DEFAULT_ACP_TIMEOUT_MS = 60_000;

/**
 * Resolves the path to the Cursor CLI or an ACP-compatible agent executable.
 *
 * Precedence:
 * 1. Explicit `override` argument (if non-empty).
 * 2. `SHORTHAND_CURSOR_EXE` environment variable (if non-empty).
 * 3. `SHORTHAND_ACP_EXE` environment variable (if non-empty).
 * 4. PATH entries:
 *    - Windows: `agent.cmd`, `agent.ps1`, `cursor.cmd`, `cursor.exe`
 *    - POSIX: `agent`, `cursor`
 * 5. Conventional platform install locations:
 *    - Windows: `%LOCALAPPDATA%\Programs\cursor\resources\app\bin\cursor.cmd`,
 *               `%LOCALAPPDATA%\cursor-agent\agent.ps1`
 *    - POSIX: `~/.local/bin/agent`, `/usr/local/bin/agent`
 */
export function detectCursorExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const configured =
    override !== undefined && override.length > 0
      ? override
      : environment.SHORTHAND_CURSOR_EXE !== undefined && environment.SHORTHAND_CURSOR_EXE.length > 0
        ? environment.SHORTHAND_CURSOR_EXE
        : environment.SHORTHAND_ACP_EXE !== undefined && environment.SHORTHAND_ACP_EXE.length > 0
          ? environment.SHORTHAND_ACP_EXE
          : undefined;
  if (configured !== undefined) return resolve(configured);

  const searchPath =
    environment.PATH ??
    environment.Path ??
    Object.entries(environment).find(([k]) => k.toUpperCase() === "PATH")?.[1] ??
    "";
  const pathEntries = searchPath
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);

  const candidates: string[] = [];

  if (platform === "win32") {
    for (const dir of pathEntries) {
      candidates.push(
        join(dir, "agent.cmd"),
        join(dir, "agent.ps1"),
        join(dir, "cursor.cmd"),
        join(dir, "cursor.exe"),
      );
    }
    const localAppData = environment.LOCALAPPDATA ?? join(environment.USERPROFILE ?? homedir(), "AppData", "Local");
    candidates.push(
      join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
      join(localAppData, "cursor-agent", "agent.ps1"),
    );
  } else {
    for (const dir of pathEntries) {
      candidates.push(join(dir, "agent"), join(dir, "cursor"));
    }
    const home = environment.HOME ?? homedir();
    candidates.push(
      join(home, ".local", "bin", "agent"),
      "/usr/local/bin/agent",
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return undefined;
}

export type AcpTransportConfig =
  | Readonly<{
      type: "stdio";
      command?: string;
      args?: readonly string[];
      env?: NodeJS.ProcessEnv;
    }>
  | Readonly<{
      type: "network";
      url: string;
      authToken?: string;
    }>;

export type AcpAgentClientOptions = Readonly<{
  transport?: AcpTransportConfig;
  model?: string;
  mode?: "ask" | "plan" | "agent";
  scratchDirectory?: string;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
}>;

export const ACP_JSON_OUTPUT_DIRECTIVE = `CRITICAL OUTPUT REQUIREMENT:
You must respond with ONLY a single raw JSON object matching this schema:
{
  "sections": [
    {
      "heading": "string (one line, no level-two headings)",
      "markdown": "string (Obsidian-flavored markdown)"
    }
  ]
}

DO NOT include any introductory or concluding conversational prose.
DO NOT wrap the output in explanations.
Output ONLY the valid JSON object starting with "{" and ending with "}".`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}

/**
 * Extracts and parses a JSON object from text that may contain markdown code fences,
 * internal code blocks, conversational preambles, or postambles.
 */
export function extractJsonFromText(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    throw new Error("Agent output was empty.");
  }

  // 1. Direct parse attempt (handles clean raw JSON, including internal code fences in markdown fields)
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to unwrap/extract
  }

  // 2. Outer markdown code fence unwrapping (payload wrapped entirely in ```json ... ```)
  const outerFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (outerFenceMatch && outerFenceMatch[1] !== undefined) {
    const unwrapFence = outerFenceMatch[1].trim();
    try {
      return JSON.parse(unwrapFence);
    } catch {
      // Fall through
    }
  }

  // 3. Conversational preamble / postamble surrounding a markdown code fence block
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let fenceBlock: RegExpExecArray | null;
  while ((fenceBlock = fenceRegex.exec(trimmed)) !== null) {
    const rawBlock = fenceBlock[1];
    if (rawBlock === undefined) continue;
    const blockContent = rawBlock.trim();
    try {
      return JSON.parse(blockContent);
    } catch {
      const bStart = blockContent.indexOf("{");
      const bEnd = blockContent.lastIndexOf("}");
      if (bStart !== -1 && bEnd > bStart) {
        try {
          return JSON.parse(blockContent.slice(bStart, bEnd + 1));
        } catch {
          // Keep checking
        }
      }
    }
  }

  // 4. Outermost object extraction: search between first '{' and last '}'
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // Fall through
    }
  }

  throw new Error("No JSON object found in agent output.");
}

function extractTextFromChunk(update: unknown): string {
  if (!isRecord(update)) return "";
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  if (isRecord(update.content)) {
    if (update.content.type === "text" && typeof update.content.text === "string") {
      return update.content.text;
    }
    if (typeof update.content.text === "string") {
      return update.content.text;
    }
  }
  if (typeof update.text === "string") return update.text;
  if (typeof update.content === "string") return update.content;
  if (isRecord(update.delta) && typeof update.delta.text === "string") return update.delta.text;
  return "";
}

interface AcpTransportBridge {
  write(message: Record<string, unknown>): Promise<void> | void;
  close(): Promise<void> | void;
}

export class AcpAgentClient implements AgentClient {
  readonly supportsVaultTools = false;

  readonly #options: AcpAgentClientOptions;
  #scratchDir: string | undefined;
  #scratchDirCreated = false;
  #bridge: AcpTransportBridge | undefined;
  #activeSessionId: string | undefined;
  #initialized = false;
  #queriesExecuted = 0;
  #nextId = 1;
  readonly #pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }
  >();
  readonly #sessionListeners = new Map<string, Set<(update: unknown) => void>>();
  #disposePromise: Promise<void> | undefined;

  constructor(options: AcpAgentClientOptions = {}) {
    this.#options = options;
  }

  get scratchDirectory(): string | undefined {
    return this.#scratchDir;
  }

  async query(request: AgentQueryRequest): Promise<AgentQueryResponse> {
    if (this.#disposePromise) {
      throw new AgentQueryError("AcpAgentClient has been disposed.");
    }

    if (request.signal?.aborted === true) {
      if (this.#activeSessionId) {
        this.#notify("session/cancel", { sessionId: this.#activeSessionId });
      }
      throw new AgentQueryError("Agent query aborted.");
    }

    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_ACP_TIMEOUT_MS;

    await this.#ensureConnection();

    if (!this.#initialized) {
      await this.#request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "shorthand-core", version: "0.20.0" },
          clientCapabilities: {},
        },
        timeoutMs,
      );

      const sessionResult = (await this.#request(
        "session/new",
        {
          cwd: this.#scratchDir,
          mcpServers: [],
          mode: this.#options.mode ?? "ask",
          ...(this.#options.model ? { model: this.#options.model } : {}),
        },
        timeoutMs,
      )) as { sessionId?: string };

      if (!isRecord(sessionResult) || typeof sessionResult.sessionId !== "string") {
        throw new AgentQueryError("ACP agent did not return a valid sessionId from session/new.");
      }
      this.#activeSessionId = sessionResult.sessionId;
      this.#initialized = true;
    } else {
      if (request.sessionId !== undefined && request.sessionId === this.#activeSessionId) {
        // Reuse active session
      } else {
        const sessionResult = (await this.#request(
          "session/new",
          {
            cwd: this.#scratchDir,
            mcpServers: [],
            mode: this.#options.mode ?? "ask",
            ...(this.#options.model ? { model: this.#options.model } : {}),
          },
          timeoutMs,
        )) as { sessionId?: string };

        if (!isRecord(sessionResult) || typeof sessionResult.sessionId !== "string") {
          throw new AgentQueryError("ACP agent did not return a valid sessionId from session/new.");
        }
        this.#activeSessionId = sessionResult.sessionId;
      }
    }

    const sessionId = this.#activeSessionId!;
    const fullPrompt = `${request.prompt}\n\n${ACP_JSON_OUTPUT_DIRECTIVE}`;
    const chunks: string[] = [];

    const onUpdate = (update: unknown) => {
      const text = extractTextFromChunk(update);
      if (text) chunks.push(text);
    };
    this.#addSessionListener(sessionId, onUpdate);

    let promptRequestId: number | undefined;
    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      if (request.signal) {
        abortListener = () => {
          this.#notify("session/cancel", { sessionId });
          if (promptRequestId !== undefined) {
            this.#pending.delete(promptRequestId);
          }
          reject(new AgentQueryError("Agent query aborted."));
        };
        request.signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    try {
      promptRequestId = this.#nextId;
      const promptPromise = this.#request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: fullPrompt }],
        },
        timeoutMs,
      );

      let promptResult: unknown;
      if (request.signal) {
        promptResult = await Promise.race([promptPromise, abortPromise]);
      } else {
        promptResult = await promptPromise;
      }

      this.#queriesExecuted += 1;

      let fullText = chunks.join("");
      if (fullText.trim().length === 0 && isRecord(promptResult)) {
        if (typeof promptResult.text === "string") {
          fullText = promptResult.text;
        } else if (Array.isArray(promptResult.content)) {
          fullText = promptResult.content
            .map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
            .join("");
        }
      }

      let structuredOutput: unknown = undefined;
      let diagnostics: readonly string[] | undefined = undefined;

      try {
        structuredOutput = extractJsonFromText(fullText);
      } catch (err) {
        structuredOutput = undefined;
        diagnostics = [
          `Failed to parse JSON from agent output: ${err instanceof Error ? err.message : String(err)}`,
          ...(fullText.trim().length > 0 ? [`Raw output: ${fullText}`] : ["Agent output was empty."]),
        ];
      }

      return {
        structuredOutput,
        sessionId,
        ...(diagnostics ? { diagnostics } : {}),
      };
    } finally {
      if (promptRequestId !== undefined && this.#pending.has(promptRequestId)) {
        this.#pending.delete(promptRequestId);
      }
      if (abortListener && request.signal) {
        request.signal.removeEventListener("abort", abortListener);
      }
      this.#removeSessionListener(sessionId, onUpdate);
    }
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#performDispose();
    return this.#disposePromise;
  }

  async #performDispose(): Promise<void> {
    if (this.#activeSessionId) {
      this.#notify("session/cancel", { sessionId: this.#activeSessionId });
    }

    if (this.#bridge) {
      try {
        await this.#bridge.close();
      } catch {
        // Deliberately swallowed
      }
      this.#bridge = undefined;
    }

    if (this.#scratchDirCreated && this.#scratchDir) {
      try {
        rmSync(this.#scratchDir, { recursive: true, force: true });
      } catch {
        // Deliberately swallowed
      }
      this.#scratchDir = undefined;
    }

    for (const [, waiter] of this.#pending) {
      waiter.reject(new AgentQueryError("AcpAgentClient has been disposed."));
    }
    this.#pending.clear();
    this.#sessionListeners.clear();
    this.#activeSessionId = undefined;
    this.#initialized = false;
  }

  #addSessionListener(sessionId: string, listener: (update: unknown) => void): void {
    let listeners = this.#sessionListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.#sessionListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
  }

  #removeSessionListener(sessionId: string, listener: (update: unknown) => void): void {
    const listeners = this.#sessionListeners.get(sessionId);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#sessionListeners.delete(sessionId);
      }
    }
  }

  async #ensureConnection(): Promise<void> {
    if (this.#bridge) return;

    if (this.#options.scratchDirectory !== undefined) {
      this.#scratchDir = this.#options.scratchDirectory;
      this.#scratchDirCreated = false;
    } else if (this.#scratchDir === undefined) {
      try {
        this.#scratchDir = mkdtempSync(join(tmpdir(), "shorthand-acp-"));
        this.#scratchDirCreated = true;
      } catch {
        this.#scratchDir = tmpdir();
        this.#scratchDirCreated = false;
      }
    }

    const transport = this.#options.transport ?? { type: "stdio" };

    if (transport.type === "stdio") {
      const environment = transport.env ?? process.env;
      const executable =
        transport.command !== undefined && transport.command.length > 0
          ? transport.command
          : detectCursorExecutable(undefined, environment);

      if (executable === undefined || executable.length === 0) {
        throw new AgentQueryError("Could not locate an ACP or Cursor executable.");
      }

      const isWindows = process.platform === "win32";
      let spawnCommand = executable;
      const baseArgs = transport.args ?? ["acp"];
      let spawnArgs = [...baseArgs];

      if (isWindows && executable.toLowerCase().endsWith(".ps1")) {
        spawnCommand = "powershell.exe";
        spawnArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executable, ...baseArgs];
      }

      const spawnFn = this.#options.spawnFn ?? spawn;
      let child: ChildProcess;
      try {
        child = spawnFn(spawnCommand, spawnArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: environment,
          windowsHide: true,
        });
      } catch (error) {
        throw new AgentQueryError(
          `Failed to spawn ACP agent process: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const stderrCapture = { text: "" };
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrCapture.text += chunk.toString("utf8");
      });

      const lineReader = new Utf8LineReader((rawLine) => {
        const line = rawLine.trim();
        if (line.length === 0) return;
        try {
          const parsed = JSON.parse(line);
          this.#handleMessage(parsed);
        } catch {
          // ignore invalid json from stdout
        }
      });

      child.stdout?.on("data", (chunk: Buffer) => lineReader.push(chunk));

      child.once("error", (err) => {
        const msg = stderrCapture.text.trim()
          ? `${err.message} (stderr: ${stderrCapture.text.trim()})`
          : err.message;
        this.#handleBridgeError(new AgentQueryError(`ACP agent child process error: ${msg}`));
      });

      child.once("close", (code) => {
        if (!this.#disposePromise) {
          const stderrMsg = stderrCapture.text.trim() ? ` (stderr: ${stderrCapture.text.trim()})` : "";
          this.#handleBridgeError(
            new AgentQueryError(`ACP agent child process closed unexpectedly with code ${code}${stderrMsg}`),
          );
        }
      });

      this.#bridge = {
        write: (msg: Record<string, unknown>) => {
          if (child.stdin?.writable) {
            child.stdin.write(`${JSON.stringify(msg)}\n`);
          }
        },
        close: () => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill();
            } catch {
              // swallowed
            }
          }
        },
      };
    } else {
      const url = transport.url;
      const headers = transport.authToken ? { Authorization: `Bearer ${transport.authToken}` } : undefined;
      let stream: Stream;
      if (url.startsWith("ws://") || url.startsWith("wss://")) {
        stream = createWebSocketStream(url, headers ? { headers } : undefined);
      } else {
        stream = createHttpStream(url, headers ? { headers } : undefined);
      }

      let closed = false;
      const bridge: AcpTransportBridge = {
        write: async (msg: Record<string, unknown>) => {
          const writer = stream.writable.getWriter();
          try {
            await writer.write(msg as any);
          } finally {
            writer.releaseLock();
          }
        },
        close: async () => {
          closed = true;
          try {
            await stream.writable.close();
          } catch {
            // swallowed
          }
        },
      };

      (async () => {
        const reader = stream.readable.getReader();
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            this.#handleMessage(value);
          }
        } catch (err) {
          if (!closed) this.#handleBridgeError(err);
        }
      })();

      this.#bridge = bridge;
    }
  }

  async #request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!this.#bridge) {
      throw new AgentQueryError("ACP transport is not connected.");
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new AgentQueryError(`ACP request '${method}' timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }

      this.#pending.set(id, {
        resolve: (val) => {
          if (timer) clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });

      try {
        const result = this.#bridge!.write({ jsonrpc: "2.0", id, method, params });
        if (result instanceof Promise) {
          result.catch((err) => {
            if (timer) clearTimeout(timer);
            this.#pending.delete(id);
            reject(err);
          });
        }
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.#bridge) return;
    try {
      this.#bridge.write({ jsonrpc: "2.0", method, params });
    } catch {
      // Deliberately swallowed for notifications
    }
  }

  #handleMessage(msg: unknown): void {
    if (!isRecord(msg)) return;

    if ("id" in msg && (typeof msg.id === "number" || typeof msg.id === "string")) {
      const waiter = this.#pending.get(msg.id);
      if (waiter) {
        this.#pending.delete(msg.id);
        if ("error" in msg && msg.error !== null && msg.error !== undefined) {
          waiter.reject(new AgentQueryError(`ACP agent returned error: ${jsonRpcErrorMessage(msg.error)}`));
        } else if ("result" in msg) {
          waiter.resolve(msg.result);
        } else {
          waiter.reject(new AgentQueryError("ACP agent response carried neither result nor error."));
        }
        return;
      }
    }

    if (msg.method === "session/update" && isRecord(msg.params)) {
      const sessionId = typeof msg.params.sessionId === "string" ? msg.params.sessionId : undefined;
      if (sessionId) {
        const listeners = this.#sessionListeners.get(sessionId);
        if (listeners) {
          for (const listener of listeners) {
            listener(msg.params.update);
          }
        }
      } else {
        for (const listeners of this.#sessionListeners.values()) {
          for (const listener of listeners) {
            listener(msg.params.update);
          }
        }
      }
    }
  }

  #handleBridgeError(error: unknown): void {
    const queryError =
      error instanceof AgentQueryError
        ? error
        : new AgentQueryError(error instanceof Error ? error.message : String(error));
    for (const [, waiter] of this.#pending) {
      waiter.reject(queryError);
    }
    this.#pending.clear();
  }
}
