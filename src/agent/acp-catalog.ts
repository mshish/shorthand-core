import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCatalogError,
  CATALOG_TIMEOUT_MS,
  type AgentCatalog,
  type AgentModel,
  type CatalogFailureReason,
} from "./catalog.js";
import { detectCursorExecutable } from "./acp-client.js";
import { Utf8LineReader } from "../ndjson.js";

export type ListAcpModelsOptions = Readonly<{
  executableOverride?: string;
  command?: string;
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
}>;

type StderrCapture = { text: string };

function withStderr(message: string, stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length === 0 ? message : `${message} stderr: ${trimmed}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}

function extractRawModels(result: unknown): unknown[] | null {
  if (!isRecord(result)) return null;

  if (isRecord(result.models) && Array.isArray(result.models.availableModels)) {
    return result.models.availableModels;
  }
  if (Array.isArray(result.availableModels)) {
    return result.availableModels;
  }
  if (Array.isArray(result.models)) {
    return result.models;
  }
  if (isRecord(result.models) && Array.isArray(result.models.models)) {
    return result.models.models;
  }
  if (Array.isArray(result.configOptions)) {
    for (const opt of result.configOptions) {
      if (isRecord(opt) && (opt.id === "model" || opt.configId === "model" || opt.category === "model")) {
        if (Array.isArray(opt.options)) {
          const flatOptions: unknown[] = [];
          for (const item of opt.options) {
            if (isRecord(item) && Array.isArray(item.options)) {
              flatOptions.push(...item.options);
            } else {
              flatOptions.push(item);
            }
          }
          return flatOptions;
        }
      }
    }
  }

  return null;
}

function parseAcpModel(value: unknown, index: number): AgentModel {
  if (!isRecord(value)) {
    throw new AgentCatalogError(
      "protocol",
      `ACP model at index ${index} is not an object: ${JSON.stringify(value)}`,
    );
  }
  const id =
    typeof value.id === "string" && value.id.length > 0
      ? value.id
      : typeof value.modelId === "string" && value.modelId.length > 0
        ? value.modelId
        : typeof value.value === "string" && value.value.length > 0
          ? value.value
          : undefined;
  if (id === undefined) {
    throw new AgentCatalogError(
      "protocol",
      `ACP model at index ${index} is missing an id: ${JSON.stringify(value)}`,
    );
  }
  const displayName =
    typeof value.displayName === "string" && value.displayName.length > 0
      ? value.displayName
      : typeof value.name === "string" && value.name.length > 0
        ? value.name
        : typeof value.label === "string" && value.label.length > 0
          ? value.label
          : id;
  const description = typeof value.description === "string" ? value.description : "";

  const efforts: string[] = [];
  if (Array.isArray(value.efforts)) {
    for (const e of value.efforts) {
      if (typeof e === "string") efforts.push(e);
      else if (isRecord(e) && typeof e.reasoningEffort === "string") efforts.push(e.reasoningEffort);
      else if (isRecord(e) && typeof e.value === "string") efforts.push(e.value);
    }
  } else if (Array.isArray(value.supportedReasoningEfforts)) {
    for (const e of value.supportedReasoningEfforts) {
      if (typeof e === "string") efforts.push(e);
      else if (isRecord(e) && typeof e.reasoningEffort === "string") efforts.push(e.reasoningEffort);
    }
  } else if (Array.isArray(value.supportedEffortLevels)) {
    for (const e of value.supportedEffortLevels) {
      if (typeof e === "string") efforts.push(e);
    }
  }

  const defaultEffort =
    typeof value.defaultEffort === "string"
      ? value.defaultEffort
      : typeof value.defaultReasoningEffort === "string"
        ? value.defaultReasoningEffort
        : undefined;

  return {
    id,
    displayName,
    description,
    efforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  };
}

/**
 * Pure mapping from ACP initialize and session/new results to AgentCatalog.
 */
export function toAcpCatalog(initResult: unknown, sessionResult: unknown): AgentCatalog {
  let authActive = true;
  let accountName: string | undefined;

  if (isRecord(initResult)) {
    if (Array.isArray(initResult.authMethods)) {
      authActive = initResult.authMethods.length === 0;
    }
    if (
      isRecord(initResult.agentInfo) &&
      typeof initResult.agentInfo.name === "string" &&
      initResult.agentInfo.name.length > 0
    ) {
      accountName = initResult.agentInfo.name;
    }
  }

  const rawModels = extractRawModels(sessionResult);
  if (rawModels === null) {
    throw new AgentCatalogError(
      "protocol",
      `ACP session/new response missing models: ${JSON.stringify(sessionResult)}`,
    );
  }

  const mappedModels = rawModels.map((m, idx) => parseAcpModel(m, idx));

  return {
    models: mappedModels,
    signedIn: authActive,
    ...(authActive ? { account: accountName ?? "Cursor CLI" } : {}),
  };
}

function classifyAcpCatalogFailure(error: unknown, stderr = ""): AgentCatalogError {
  if (error instanceof AgentCatalogError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  const reason: CatalogFailureReason = code === "ENOENT" ? "executable-not-found" : "spawn-failed";
  const message = error instanceof Error ? error.message : String(error);
  return new AgentCatalogError(
    reason,
    withStderr(`Failed to fetch the ACP model catalog: ${message}`, stderr),
    { cause: error },
  );
}

function runAcpHandshake(
  child: ChildProcess,
  scratchDir: string,
  stderrCapture: StderrCapture,
): Promise<AgentCatalog> {
  return new Promise<AgentCatalog>((resolveHandshake, rejectHandshake) => {
    if (child.stdout === null || child.stdin === null) {
      rejectHandshake(new AgentCatalogError("spawn-failed", "ACP agent child has no piped stdio."));
      return;
    }
    const stdout = child.stdout;
    const stdin = child.stdin;

    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectHandshake(error);
    };
    const succeed = (catalog: AgentCatalog): void => {
      if (settled) return;
      settled = true;
      resolveHandshake(catalog);
    };

    child.once("error", (error) => fail(classifyAcpCatalogFailure(error, stderrCapture.text)));
    child.once("close", (code) => {
      fail(
        new AgentCatalogError(
          "spawn-failed",
          withStderr(
            `ACP agent exited (code ${String(code)}) before the catalog handshake completed.`,
            stderrCapture.text,
          ),
        ),
      );
    });

    let nextId = 1;
    const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: unknown) => void }>();

    const write = (message: Record<string, unknown>): void => {
      stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: unknown = {}): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        write({ jsonrpc: "2.0", id, method, params });
      });
    };

    const lineReader = new Utf8LineReader((rawLine) => {
      const line = rawLine.trim();
      if (line.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail(
          new AgentCatalogError(
            "protocol",
            `ACP agent sent a line that is not valid JSON: ${line}`,
            { cause: error },
          ),
        );
        return;
      }

      if (!isRecord(parsed)) {
        fail(
          new AgentCatalogError(
            "protocol",
            `ACP agent sent a JSON-RPC message that is not an object: ${line}`,
          ),
        );
        return;
      }

      if (typeof parsed.id !== "number") return;
      const waiter = pending.get(parsed.id);
      if (waiter === undefined) return;
      pending.delete(parsed.id);

      if ("error" in parsed && parsed.error !== undefined && parsed.error !== null) {
        waiter.reject(
          new AgentCatalogError(
            "protocol",
            `ACP agent returned a JSON-RPC error: ${jsonRpcErrorMessage(parsed.error)}`,
          ),
        );
      } else if ("result" in parsed) {
        waiter.resolve(parsed.result);
      } else {
        waiter.reject(
          new AgentCatalogError("protocol", "ACP agent response carried neither result nor error."),
        );
      }
    });

    stdout.on("data", (chunk: Buffer) => {
      try {
        lineReader.push(chunk);
      } catch (error) {
        fail(
          error instanceof AgentCatalogError
            ? error
            : new AgentCatalogError(
                "protocol",
                `ACP agent stdout handling failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              ),
        );
      }
    });

    (async () => {
      const initResult = await request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "shorthand-core", version: "0.20.0" },
      });
      const sessionResult = await request("session/new", {
        cwd: scratchDir,
        mcpServers: [],
      });
      succeed(toAcpCatalog(initResult, sessionResult));
    })().catch(fail);
  });
}

/**
 * Discovers the ACP model catalog by probing the agent CLI over stdio.
 */
export async function listAcpModels(options: ListAcpModelsOptions = {}): Promise<AgentCatalog> {
  const environment = options.environment ?? process.env;
  const executable =
    options.command !== undefined && options.command.length > 0
      ? options.command
      : detectCursorExecutable(options.executableOverride, environment);

  if (executable === undefined || executable.length === 0) {
    throw new AgentCatalogError(
      "executable-not-found",
      "Could not locate an ACP or Cursor executable.",
    );
  }

  const isWindows = process.platform === "win32";
  let spawnCommand = executable;
  const baseArgs = options.args ?? ["acp"];
  let spawnArgs = [...baseArgs];

  if (isWindows && executable.toLowerCase().endsWith(".ps1")) {
    spawnCommand = "powershell.exe";
    spawnArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executable, ...baseArgs];
  }

  const spawnFn = options.spawnFn ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnFn(spawnCommand, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
      windowsHide: true,
    });
  } catch (error) {
    throw classifyAcpCatalogFailure(error);
  }

  let scratchDir: string | undefined;
  try {
    scratchDir = mkdtempSync(join(tmpdir(), "shorthand-acp-catalog-"));
  } catch {
    scratchDir = tmpdir();
  }

  const stderrCapture: StderrCapture = { text: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrCapture.text += chunk.toString("utf8");
  });

  const handshake = runAcpHandshake(child, scratchDir, stderrCapture);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AgentCatalogError(
            "timeout",
            withStderr(`ACP model catalog fetch exceeded ${timeoutMs}ms.`, stderrCapture.text),
          ),
        ),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([handshake, timeout]);
  } catch (error) {
    throw classifyAcpCatalogFailure(error, stderrCapture.text);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // Deliberately swallowed
      }
    }
    if (scratchDir !== undefined && scratchDir !== tmpdir()) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // Deliberately swallowed
      }
    }
    handshake.catch(() => {});
  }
}
