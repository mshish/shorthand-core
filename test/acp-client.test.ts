import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ChildProcess, spawn } from "node:child_process";
import { AgentQueryError, type AgentQueryRequest } from "../src/agent/contract.js";
import {
  AcpAgentClient,
  type AcpAgentClientOptions,
} from "../src/agent/acp-client.js";
import { Utf8LineReader } from "../src/ndjson.js";

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

describe("AcpAgentClient", () => {
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
      params: { protocolVersion: 1 },
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
          const msg = JSON.parse(raw.toString());
          if (msg.method === "initialize") {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
          } else if (msg.method === "session/new") {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "net-session-123" } }));
          } else if (msg.method === "session/prompt") {
            ws.send(JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "net-session-123",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: JSON.stringify({ sections: expectedSections }) },
                },
              },
            }));
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
          }
        },
      },
    });

    try {
      const client = new AcpAgentClient({
        transport: { type: "network", url: `ws://localhost:${server.port}` },
      });

      const response = await client.query(makeDummyRequest());
      expect(response.sessionId).toBe("net-session-123");
      expect(response.structuredOutput).toEqual({ sections: expectedSections });
      await client.dispose();
    } finally {
      server.stop(true);
    }
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
