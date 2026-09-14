import { beforeEach, describe, expect, it, mock } from "bun:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ChildProcess, spawn } from "node:child_process";
import type { HttpStreamOptions } from "@agentclientprotocol/sdk/experimental/http-client";
import type { WebSocketLike, WebSocketStreamOptions } from "@agentclientprotocol/sdk/experimental/ws-client";
import { AgentQueryError, type AgentQueryRequest } from "../src/agent/contract.js";
import type { AcpAgentClientOptions } from "../src/agent/acp-client.js";
import { CORE_VERSION } from "../src/config.js";
import { Utf8LineReader } from "../src/ndjson.js";

/**
 * The SDK transports are wrapped, not replaced: the WebSocket test below drives a real
 * `Bun.serve` through the SDK's own stream, and only the options the client hands the SDK
 * need to be observable. The real functions are captured BEFORE `mock.module` because bun
 * mutates the live module namespace in place — reading them back through the namespace
 * inside the wrapper would recurse.
 */
const actualWsClient = await import("@agentclientprotocol/sdk/experimental/ws-client");
const realCreateWebSocketStream = actualWsClient.createWebSocketStream;
const actualHttpClient = await import("@agentclientprotocol/sdk/experimental/http-client");
const realCreateHttpStream = actualHttpClient.createHttpStream;

const webSocketStreams: { url: string; options: WebSocketStreamOptions | undefined }[] = [];
const httpStreams: { url: string; options: HttpStreamOptions | undefined }[] = [];

mock.module("@agentclientprotocol/sdk/experimental/ws-client", () => ({
  ...actualWsClient,
  createWebSocketStream: (url: string, options?: WebSocketStreamOptions) => {
    webSocketStreams.push({ url, options });
    return realCreateWebSocketStream(url, options);
  },
}));

mock.module("@agentclientprotocol/sdk/experimental/http-client", () => ({
  ...actualHttpClient,
  createHttpStream: (url: string, options?: HttpStreamOptions) => {
    httpStreams.push({ url, options });
    return realCreateHttpStream(url, options);
  },
}));

const { AcpAgentClient, extractJsonFromText } = await import("../src/agent/acp-client.js");

type MockChild = Omit<ChildProcess, "exitCode"> & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
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
    sessionId?: string;
    chunks?: readonly string[];
    chunkDelayMs?: number;
    rpcError?: { code: number; message: string };
    onMessage?: (msg: Record<string, unknown>) => void;
    onCancel?: (params: Record<string, unknown>) => void;
  } = {},
) {
  const sessionId = options.sessionId ?? "mock-session-123";
  const lineReader = new Utf8LineReader((rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    const msg = JSON.parse(line) as Record<string, unknown>;
    options.onMessage?.(msg);

    if (msg.method === "initialize") {
      const response = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "Cursor CLI", version: "0.20.0" },
        },
      };
      child.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }

    if (msg.method === "session/new") {
      const response = {
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId },
      };
      child.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }

    if (msg.method === "session/prompt") {
      if (options.rpcError) {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: options.rpcError })}\n`,
        );
        return;
      }

      const chunks = options.chunks ?? [];
      const sendChunks = () => {
        for (const chunk of chunks) {
          const notification = {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: chunk },
              },
            },
          };
          child.stdout.write(`${JSON.stringify(notification)}\n`);
        }
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { stopReason: "end_turn" },
        };
        child.stdout.write(`${JSON.stringify(response)}\n`);
      };

      if (options.chunkDelayMs !== undefined && options.chunkDelayMs > 0) {
        setTimeout(sendChunks, options.chunkDelayMs);
      } else {
        sendChunks();
      }
      return;
    }

    if (msg.method === "session/cancel") {
      options.onCancel?.((msg.params as Record<string, unknown>) ?? {});
      return;
    }
  });

  child.stdin.on("data", (chunk: Buffer) => lineReader.push(chunk));
}

function makeDummyRequest(overrides: Partial<AgentQueryRequest> = {}): AgentQueryRequest {
  return {
    prompt: "Generate meeting notes",
    systemPrompt: "You are an assistant",
    tools: [],
    settingSources: [],
    maxTurns: 1,
    outputSchema: {},
    ...overrides,
  };
}

type Section = Readonly<{ heading: string; markdown: string }>;

/** The frames an ACP agent sends back over a network transport for one full query. */
function acpNetworkReplies(raw: string, sessionId: string, sections: readonly Section[]): string[] {
  const msg = JSON.parse(raw) as Record<string, unknown>;
  if (msg.method === "initialize") {
    return [JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } })];
  }
  if (msg.method === "session/new") {
    return [JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId } })];
  }
  if (msg.method === "session/prompt") {
    return [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify({ sections }) },
          },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }),
    ];
  }
  return [];
}

/**
 * A `WebSocket` class that answers the ACP handshake in-process, standing in for the shim
 * `createAppWebSocketConstructor` returns. Nothing dials the URL, so a transport that
 * ignored the injected constructor could not complete a query through it.
 */
function fakeWebSocketConstructor(
  dialled: string[],
  sessionId: string,
  sections: readonly Section[],
) {
  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSED = 3;

  return class FakeWebSocket implements WebSocketLike {
    readyState = CONNECTING;
    readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(url: string, _protocols?: string | string[]) {
      dialled.push(url);
      // Opens a turn later, as a real socket does, so the SDK's wait-for-open path runs.
      queueMicrotask(() => {
        this.readyState = OPEN;
        this.#dispatch("open", { type: "open" });
      });
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.#listeners.get(type) ?? new Set<(event: unknown) => void>();
      listeners.add(listener);
      this.#listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.#listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
      // Asynchronous because a real socket never answers inside `send`, and the SDK enqueues
      // onto the readable it is still returning from when the write happens.
      queueMicrotask(() => {
        for (const reply of acpNetworkReplies(data, sessionId, sections)) {
          this.#dispatch("message", { data: reply });
        }
      });
    }

    close(code?: number, reason?: string): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.#dispatch("close", { type: "close", code: code ?? 1000, reason: reason ?? "" });
    }

    #dispatch(type: string, event: unknown): void {
      for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
    }
  };
}

describe("AcpAgentClient", () => {
  beforeEach(() => {
    webSocketStreams.length = 0;
    httpStreams.length = 0;
  });

  it("enforces supportsVaultTools === false", () => {
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
    });
    expect(client.supportsVaultTools).toBe(false);
  });

  it("successfully parses raw JSON from agent_message_chunk updates", async () => {
    const mockChild = createMockProcess();
    const sentMessages: Record<string, unknown>[] = [];
    const expectedSections = [
      { heading: "Summary", markdown: "* Item 1\n* Item 2" },
      { heading: "Action Items", markdown: "* [ ] Task 1" },
    ];
    wireMockAcpServer(mockChild, {
      chunks: [JSON.stringify({ sections: expectedSections })],
      onMessage: (msg) => sentMessages.push(msg),
    });

    const spawnFn: typeof spawn = (() => mockChild) as unknown as typeof spawn;
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
      spawnFn,
    });

    const response = await client.query(makeDummyRequest());
    expect(response.sessionId).toBe("mock-session-123");
    expect(response.structuredOutput).toEqual({ sections: expectedSections });
    expect(response.diagnostics).toBeUndefined();

    // Verify initialize and session/new handshake
    expect(sentMessages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        // Read from the constant, not repeated: a literal here is what let the shipped value
        // sit at 0.20.0 while the package moved on.
        clientInfo: { name: "shorthand-core", version: CORE_VERSION },
      },
    });
    expect(sentMessages[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { mcpServers: [], mode: "ask" },
    });
    expect(sentMessages[2]).toMatchObject({
      jsonrpc: "2.0",
      method: "session/prompt",
      params: {
        sessionId: "mock-session-123",
        prompt: [{ type: "text" }],
      },
    });

    await client.dispose();
  });

  it("unwraps markdown-wrapped JSON and ignores conversational preamble and postamble", async () => {
    const mockChild = createMockProcess();
    const expectedSections = [{ heading: "Highlights", markdown: "* All green" }];
    const chunks = [
      "Here are the meeting notes you asked for:\n\n```json\n",
      JSON.stringify({ sections: expectedSections }, null, 2),
      "\n```\n\nI hope this is helpful!",
    ];
    wireMockAcpServer(mockChild, { chunks });

    const spawnFn: typeof spawn = (() => mockChild) as unknown as typeof spawn;
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
      spawnFn,
    });

    const response = await client.query(makeDummyRequest());
    expect(response.structuredOutput).toEqual({ sections: expectedSections });
    expect(response.diagnostics).toBeUndefined();

    await client.dispose();
  });

  it("extracts clean JSON when section markdown contains internal code fences", async () => {
    const mockChild = createMockProcess();
    const expectedSections = [
      {
        heading: "Code Example",
        markdown: "Here is the sample:\n```typescript\nconst x: number = 42;\nconsole.log(x);\n```\nDone.",
      },
    ];
    const chunks = [
      "Here is your note:\n```json\n",
      JSON.stringify({ sections: expectedSections }),
      "\n```\nAll done.",
    ];
    wireMockAcpServer(mockChild, { chunks });

    const spawnFn: typeof spawn = (() => mockChild) as unknown as typeof spawn;
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
      spawnFn,
    });

    const response = await client.query(makeDummyRequest());
    expect(response.structuredOutput).toEqual({ sections: expectedSections });
    expect(response.diagnostics).toBeUndefined();

    await client.dispose();
  });

  it("enforces timeoutMs and rejects with AgentQueryError when agent stalls", async () => {
    const mockChild = createMockProcess();
    wireMockAcpServer(mockChild, {
      chunkDelayMs: 200, // slower than timeoutMs
    });

    const spawnFn: typeof spawn = (() => mockChild) as unknown as typeof spawn;
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
      timeoutMs: 30,
      spawnFn,
    });

    await expect(client.query(makeDummyRequest())).rejects.toThrow(AgentQueryError);
    await expect(client.query(makeDummyRequest())).rejects.toThrow("timed out");

    await client.dispose();
  });

  it("populates diagnostics on invalid JSON without throwing", async () => {
    const mockChild = createMockProcess();
    wireMockAcpServer(mockChild, {
      chunks: ["Sorry, I could not process your request into structured sections."],
    });

    const spawnFn: typeof spawn = (() => mockChild) as unknown as typeof spawn;
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
      spawnFn,
    });

    const response = await client.query(makeDummyRequest());
    expect(response.sessionId).toBe("mock-session-123");
    expect(response.structuredOutput).toBeUndefined();
    expect(response.diagnostics).toBeDefined();
    expect(response.diagnostics!.length).toBeGreaterThan(0);
    expect(response.diagnostics![0]).toContain("JSON");

    await client.dispose();
  });

  it("maintains session continuity and reuses sessionId across multiple queries", async () => {
    const mockChild = createMockProcess();
    const sentMessages: Record<string, unknown>[] = [];
    const expectedSections = [{ heading: "Topic", markdown: "* Info" }];
    wireMockAcpServer(mockChild, {
      sessionId: "reusable-session-abc",
      chunks: [JSON.stringify({ sections: expectedSections })],
      onMessage: (msg) => sentMessages.push(msg),
    });

    const spawnFn: typeof spawn = (() => mockChild) as unknown as typeof spawn;
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
      spawnFn,
    });

    // Query 1: fresh session
    const res1 = await client.query(makeDummyRequest());
    expect(res1.sessionId).toBe("reusable-session-abc");

    // Query 2: provide the active sessionId
    const res2 = await client.query(
      makeDummyRequest({ sessionId: "reusable-session-abc" }),
    );
    expect(res2.sessionId).toBe("reusable-session-abc");

    // Verify messages: initialize (1), session/new (2), prompt 1 (3), prompt 2 (4)
    const methods = sentMessages.map((m) => m.method);
    expect(methods).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/prompt",
    ]);

    await client.dispose();
  });

  it("handles abort signal by sending session/cancel and throwing AgentQueryError", async () => {
    const mockChild = createMockProcess();
    let cancelled = false;
    wireMockAcpServer(mockChild, {
      chunkDelayMs: 200,
      onCancel: () => {
        cancelled = true;
      },
    });

    const spawnFn: typeof spawn = (() => mockChild) as unknown as typeof spawn;
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
      spawnFn,
    });

    const controller = new AbortController();
    const queryPromise = client.query(
      makeDummyRequest({ signal: controller.signal }),
    );

    // Abort after prompt has been sent
    setTimeout(() => controller.abort(), 5);

    await expect(queryPromise).rejects.toThrow(AgentQueryError);
    await expect(queryPromise).rejects.toThrow("Agent query aborted.");
    expect(cancelled).toBe(true);

    await client.dispose();
  });

  it("performs clean disposal and deletes temporary scratch directory", async () => {
    const mockChild = createMockProcess();
    wireMockAcpServer(mockChild, {
      chunks: [JSON.stringify({ sections: [] })],
    });

    const spawnFn: typeof spawn = (() => mockChild) as unknown as typeof spawn;
    const client = new AcpAgentClient({
      transport: { type: "stdio", command: "agent" },
      spawnFn,
    });

    await client.query(makeDummyRequest());
    const scratchDir = client.scratchDirectory;
    expect(scratchDir).toBeDefined();
    expect(existsSync(scratchDir!)).toBe(true);

    await client.dispose();
    expect(existsSync(scratchDir!)).toBe(false);
    expect(mockChild.killed).toBe(true);
  });

  it("supports network transport over WebSocket", async () => {
    const expectedSections = [{ heading: "Net Section", markdown: "* Net Content" }];
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Upgrade failed", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          for (const reply of acpNetworkReplies(raw.toString(), "net-session-123", expectedSections)) {
            ws.send(reply);
          }
        },
      },
    });

    try {
      const client = new AcpAgentClient({
        transport: {
          type: "network",
          url: `ws://localhost:${server.port}`,
          WebSocket: globalThis.WebSocket,
        },
      });

      const response = await client.query(makeDummyRequest());
      expect(response.sessionId).toBe("net-session-123");
      expect(response.structuredOutput).toEqual({ sections: expectedSections });
      expect(webSocketStreams).toEqual([
        { url: `ws://localhost:${server.port}`, options: { WebSocket: globalThis.WebSocket } },
      ]);
      await client.dispose();
    } finally {
      server.stop(true);
    }
  });

  it("dials wss:// through the injected WebSocket constructor", async () => {
    const expectedSections = [{ heading: "Relayed", markdown: "* Through the app" }];
    const dialled: string[] = [];
    const AppWebSocket = fakeWebSocketConstructor(dialled, "relay-session-1", expectedSections);

    const client = new AcpAgentClient({
      transport: { type: "network", url: "wss://agent.example/acp", WebSocket: AppWebSocket },
    });

    const response = await client.query(makeDummyRequest());
    expect(response.sessionId).toBe("relay-session-1");
    expect(response.structuredOutput).toEqual({ sections: expectedSections });
    expect(dialled).toEqual(["wss://agent.example/acp"]);
    expect(webSocketStreams.at(-1)?.options?.WebSocket).toBe(AppWebSocket);
    await client.dispose();
  });

  it("passes the injected fetch to the HTTP transport for https://", async () => {
    const fetched: string[] = [];
    const appFetch = (async (input: unknown) => {
      fetched.push(String(input));
      return new Response("no relay", { status: 502 });
    }) as typeof globalThis.fetch;

    const client = new AcpAgentClient({
      transport: { type: "network", url: "https://agent.example/acp", fetch: appFetch },
    });

    await expect(client.query(makeDummyRequest())).rejects.toThrow();
    expect(fetched).toEqual(["https://agent.example/acp"]);
    expect(httpStreams).toEqual([{ url: "https://agent.example/acp", options: { fetch: appFetch } }]);
    await client.dispose();
  });

  it("throws AgentQueryError when no executable can be discovered", async () => {
    const client = new AcpAgentClient({
      transport: {
        type: "stdio",
        env: { PATH: "", Path: "", LOCALAPPDATA: "C:\\empty", USERPROFILE: "C:\\empty", HOME: "C:\\empty" },
      },
    });
    await expect(client.query(makeDummyRequest())).rejects.toThrow(AgentQueryError);
  });
});

describe("extractJsonFromText", () => {
  it("parses clean raw JSON directly even with internal code fences", () => {
    const payload = JSON.stringify({
      sections: [{ heading: "Code", markdown: "```js\nconsole.log(1);\n```" }],
    });
    expect(extractJsonFromText(payload)).toEqual({
      sections: [{ heading: "Code", markdown: "```js\nconsole.log(1);\n```" }],
    });
  });

  it("unwraps outer markdown fence with internal code blocks", () => {
    const raw = "```json\n" + JSON.stringify({
      sections: [{ heading: "Code", markdown: "```python\nprint('hello')\n```" }],
    }) + "\n```";
    expect(extractJsonFromText(raw)).toEqual({
      sections: [{ heading: "Code", markdown: "```python\nprint('hello')\n```" }],
    });
  });

  it("extracts JSON surrounded by conversational text with curly braces", () => {
    const raw = "Note {version: 1.0}:\n\n```json\n" + JSON.stringify({
      sections: [{ heading: "Summary", markdown: "* Done" }],
    }) + "\n```\n\nSignature {id: 42}";
    expect(extractJsonFromText(raw)).toEqual({
      sections: [{ heading: "Summary", markdown: "* Done" }],
    });
  });

  it("throws when agent output has no JSON object", () => {
    expect(() => extractJsonFromText("I am an AI assistant and I cannot do that.")).toThrow(
      "No JSON object found in agent output.",
    );
  });
});

