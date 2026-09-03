import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { AgentCatalogError } from "../src/agent/catalog.js";
import {
  listAcpModels,
  toAcpCatalog,
  type ListAcpModelsOptions,
} from "../src/agent/acp-catalog.js";
import { Utf8LineReader } from "../src/ndjson.js";

type MockChild = Omit<ChildProcess, "exitCode"> & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  exitCode: number | null;
};

function createMockProcess(): MockChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: function (this: MockChild, _signal?: NodeJS.Signals | number) {
      this.killed = true;
      this.exitCode = 0;
      emitter.emit("close", 0);
      return true;
    },
  }) as unknown as MockChild;

  return child;
}

function wireMockAcpServer(
  child: MockChild,
  options: {
    authMethods?: unknown[];
    agentInfo?: { name: string; version: string };
    modelsResult?: unknown;
    interleaveNotification?: boolean;
    rpcError?: { code: number; message: string };
    invalidJson?: boolean;
    missingResultAndError?: boolean;
    delayMs?: number;
    ignoreSessionNew?: boolean;
    onMessage?: (msg: Record<string, unknown>) => void;
  } = {},
) {
  const lineReader = new Utf8LineReader((rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    const msg = JSON.parse(line) as Record<string, unknown>;
    options.onMessage?.(msg);

    if (msg.method === "initialize") {
      if (options.interleaveNotification) {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/status", params: { status: "ready" } })}\n`,
        );
      }
      const response = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          authMethods: options.authMethods ?? [],
          agentInfo: options.agentInfo ?? { name: "Cursor CLI", version: "0.20.0" },
        },
      };
      child.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }

    if (msg.method === "session/new") {
      if (options.ignoreSessionNew) return;
      if (options.invalidJson) {
        child.stdout.write("this is not valid json\n");
        return;
      }
      if (options.rpcError) {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: options.rpcError })}\n`);
        return;
      }
      if (options.missingResultAndError) {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id })}\n`);
        return;
      }
      const result = options.modelsResult ?? {
        sessionId: "mock-session",
        availableModels: [
          { id: "claude-3-7-sonnet", displayName: "Claude 3.7 Sonnet", description: "Anthropic frontier model" },
        ],
      };
      const response = { jsonrpc: "2.0", id: msg.id, result };
      child.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }
  });

  child.stdin.on("data", (chunk: Buffer) => lineReader.push(chunk));
}

describe("toAcpCatalog", () => {
  it("maps availableModels array into AgentCatalog", () => {
    const initResult = {
      protocolVersion: 1,
      authMethods: [],
      agentInfo: { name: "Cursor CLI", version: "0.20.0" },
    };
    const sessionResult = {
      sessionId: "s1",
      availableModels: [
        {
          id: "claude-3-7-sonnet",
          displayName: "Claude 3.7 Sonnet",
          description: "Anthropic frontier model",
          efforts: ["low", "high"],
          defaultEffort: "low",
        },
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          description: "OpenAI coding model",
        },
      ],
    };

    const catalog = toAcpCatalog(initResult, sessionResult);
    expect(catalog.signedIn).toBe(true);
    expect(catalog.account).toBe("Cursor CLI");
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]).toEqual({
      id: "claude-3-7-sonnet",
      displayName: "Claude 3.7 Sonnet",
      description: "Anthropic frontier model",
      efforts: ["low", "high"],
      defaultEffort: "low",
    });
    expect(catalog.models[1]).toEqual({
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "OpenAI coding model",
      efforts: [],
    });
  });

  it("maps models.availableModels shape into AgentCatalog", () => {
    const initResult = { protocolVersion: 1 };
    const sessionResult = {
      sessionId: "s2",
      models: {
        currentModelId: "cursor-small",
        availableModels: [
          { id: "cursor-small", displayName: "Cursor Small", description: "Fast autocomplete" },
        ],
      },
    };

    const catalog = toAcpCatalog(initResult, sessionResult);
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.id).toBe("cursor-small");
    expect(catalog.models[0]?.displayName).toBe("Cursor Small");
    expect(catalog.models[0]?.description).toBe("Fast autocomplete");
    expect(catalog.models[0]?.efforts).toEqual([]);
  });

  it("maps models array shape into AgentCatalog", () => {
    const initResult = { protocolVersion: 1 };
    const sessionResult = {
      sessionId: "s3",
      models: [
        { modelId: "deepseek-coder", label: "DeepSeek Coder", description: "Reasoning model" },
      ],
    };

    const catalog = toAcpCatalog(initResult, sessionResult);
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.id).toBe("deepseek-coder");
    expect(catalog.models[0]?.displayName).toBe("DeepSeek Coder");
    expect(catalog.models[0]?.description).toBe("Reasoning model");
  });

  it("maps configOptions model selector into AgentCatalog", () => {
    const initResult = { protocolVersion: 1 };
    const sessionResult = {
      sessionId: "s4",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          options: [
            { value: "o3-mini", name: "o3-mini", description: "Reasoning model" },
            { value: "gpt-4o", name: "GPT-4o", description: "Omni model" },
          ],
        },
      ],
    };

    const catalog = toAcpCatalog(initResult, sessionResult);
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]?.id).toBe("o3-mini");
    expect(catalog.models[1]?.id).toBe("gpt-4o");
  });

  it("marks signedIn: false and omits account when authMethods is non-empty", () => {
    const initResult = {
      protocolVersion: 1,
      authMethods: [
        { id: "cursor_login", name: "Cursor Account", description: "Log in with Cursor" },
      ],
    };
    const sessionResult = {
      sessionId: "s5",
      availableModels: [{ id: "cursor-default", name: "Default", description: "" }],
    };

    const catalog = toAcpCatalog(initResult, sessionResult);
    expect(catalog.signedIn).toBe(false);
    expect(catalog.account).toBeUndefined();
  });

  it("marks signedIn: true when authMethods is empty or missing", () => {
    const initResult = {
      protocolVersion: 1,
      authMethods: [],
      agentInfo: { name: "Cursor Pro" },
    };
    const sessionResult = {
      sessionId: "s6",
      availableModels: [{ id: "m1", name: "Model 1", description: "" }],
    };

    const catalog = toAcpCatalog(initResult, sessionResult);
    expect(catalog.signedIn).toBe(true);
    expect(catalog.account).toBe("Cursor Pro");
  });

  it("throws protocol AgentCatalogError when session/new has no models", () => {
    const initResult = { protocolVersion: 1 };
    const sessionResult = { sessionId: "s7" };

    expect(() => toAcpCatalog(initResult, sessionResult)).toThrow(AgentCatalogError);
    try {
      toAcpCatalog(initResult, sessionResult);
    } catch (error) {
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  it("throws protocol AgentCatalogError when a model is missing an id", () => {
    const initResult = { protocolVersion: 1 };
    const sessionResult = {
      sessionId: "s8",
      availableModels: [{ name: "No ID Model", description: "Missing id" }],
    };

    expect(() => toAcpCatalog(initResult, sessionResult)).toThrow(AgentCatalogError);
    try {
      toAcpCatalog(initResult, sessionResult);
    } catch (error) {
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });
});

describe("listAcpModels", () => {
  it("rejects with executable-not-found when no executable is discovered", async () => {
    const emptyDir = "D:\\non-existent-dir-for-shorthand-test";
    try {
      await listAcpModels({
        environment: {
          PATH: emptyDir,
          LOCALAPPDATA: emptyDir,
          USERPROFILE: emptyDir,
          HOME: emptyDir,
        },
      });
      throw new Error("expected listAcpModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("executable-not-found");
    }
  });

  it("executes the full handshake sequence (initialize -> session/new) and returns catalog", async () => {
    const child = createMockProcess();
    const sentMessages: Record<string, unknown>[] = [];
    let cwdUsed: string | undefined;

    wireMockAcpServer(child, {
      interleaveNotification: true,
      onMessage: (msg) => {
        sentMessages.push(msg);
        if (msg.method === "session/new") {
          const params = msg.params as { cwd?: string };
          cwdUsed = params.cwd;
        }
      },
      modelsResult: {
        sessionId: "sess-123",
        availableModels: [
          { id: "claude-sonnet", name: "Claude Sonnet", description: "Anthropic" },
          { id: "gpt-5", name: "GPT-5", description: "OpenAI" },
        ],
      },
    });

    const catalog = await listAcpModels({
      executableOverride: "mock-agent",
      spawnFn: (() => child) as unknown as typeof spawn,
    });

    expect(catalog.signedIn).toBe(true);
    expect(catalog.account).toBe("Cursor CLI");
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models.map((m) => m.id)).toEqual(["claude-sonnet", "gpt-5"]);

    // Verify initialize request parameters
    const initReq = sentMessages.find((m) => m.method === "initialize");
    expect(initReq).toBeDefined();
    expect(initReq?.id).toBe(1);
    expect(initReq?.params).toEqual({
      protocolVersion: 1,
      clientInfo: { name: "shorthand-core", version: "0.20.0" },
    });

    // Verify session/new request parameters
    const sessionReq = sentMessages.find((m) => m.method === "session/new");
    expect(sessionReq).toBeDefined();
    expect(sessionReq?.id).toBe(2);
    expect((sessionReq?.params as { mcpServers: unknown[] }).mcpServers).toEqual([]);
    expect(typeof cwdUsed).toBe("string");

    // Verify child process was terminated immediately
    expect(child.killed).toBe(true);
  });

  it("launches via powershell.exe on Windows when executable ends with .ps1", async () => {
    const child = createMockProcess();
    wireMockAcpServer(child);

    let spawnedCommand: string | undefined;
    let spawnedArgs: readonly string[] | undefined;

    const mockSpawn = ((cmd: string, args?: readonly string[]) => {
      spawnedCommand = cmd;
      spawnedArgs = args;
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    await listAcpModels({
      executableOverride: "C:\\tools\\agent.ps1",
      args: ["acp"],
      spawnFn: mockSpawn,
    });

    if (process.platform === "win32") {
      expect(spawnedCommand).toBe("powershell.exe");
      expect(spawnedArgs).toEqual([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("C:\\tools\\agent.ps1"),
        "acp",
      ]);
    }
    expect(child.killed).toBe(true);
  });

  it("rejects with timeout and terminates child process when probe exceeds timeoutMs", async () => {
    const child = createMockProcess();
    wireMockAcpServer(child, { ignoreSessionNew: true });

    try {
      await listAcpModels({
        executableOverride: "mock-agent",
        timeoutMs: 50,
        spawnFn: (() => child) as unknown as typeof spawn,
      });
      throw new Error("expected listAcpModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("timeout");
    }

    expect(child.killed).toBe(true);
  });

  it("rejects with spawn-failed when child process exits prematurely", async () => {
    const child = createMockProcess();

    // Child closes immediately before responding
    setTimeout(() => {
      child.exitCode = 1;
      child.emit("close", 1);
    }, 10);

    try {
      await listAcpModels({
        executableOverride: "mock-agent",
        spawnFn: (() => child) as unknown as typeof spawn,
      });
      throw new Error("expected listAcpModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("spawn-failed");
    }
  });

  it("rejects with protocol error when child sends invalid JSON", async () => {
    const child = createMockProcess();
    wireMockAcpServer(child, { invalidJson: true });

    try {
      await listAcpModels({
        executableOverride: "mock-agent",
        spawnFn: (() => child) as unknown as typeof spawn,
      });
      throw new Error("expected listAcpModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
    expect(child.killed).toBe(true);
  });

  it("rejects with protocol error when child returns a JSON-RPC error", async () => {
    const child = createMockProcess();
    wireMockAcpServer(child, { rpcError: { code: -32603, message: "Internal error" } });

    try {
      await listAcpModels({
        executableOverride: "mock-agent",
        spawnFn: (() => child) as unknown as typeof spawn,
      });
      throw new Error("expected listAcpModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
      expect((error as AgentCatalogError).message).toContain("Internal error");
    }
    expect(child.killed).toBe(true);
  });

  it("rejects with protocol error when response has neither result nor error", async () => {
    const child = createMockProcess();
    wireMockAcpServer(child, { missingResultAndError: true });

    try {
      await listAcpModels({
        executableOverride: "mock-agent",
        spawnFn: (() => child) as unknown as typeof spawn,
      });
      throw new Error("expected listAcpModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
    expect(child.killed).toBe(true);
  });

  it("captures stderr and includes it in failure diagnostics", async () => {
    const child = createMockProcess();

    setTimeout(() => {
      child.stderr.write("Fatal startup error: port already in use\n");
      child.exitCode = 1;
      child.emit("close", 1);
    }, 10);

    try {
      await listAcpModels({
        executableOverride: "mock-agent",
        spawnFn: (() => child) as unknown as typeof spawn,
      });
      throw new Error("expected listAcpModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).message).toContain("Fatal startup error: port already in use");
    }
  });
});
