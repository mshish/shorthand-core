import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppUnavailableError, ShorthandAppClient, type AppEvent } from "../src/app/client.js";
import { readDiscovery } from "../src/app/discovery.js";
import { requestSocketDiscoveryPath } from "../src/config.js";
import { Utf8LineReader } from "../src/ndjson.js";

const DEFAULT_HELLO = { t: "hello", protocol: 1, version: "0.5.0", capabilities: ["credential", "http-fetch", "ws-relay"] };

type WireRequest = Readonly<{ id: string; method: string; params: Record<string, unknown> }>;

type FakeApp = {
  readonly path: string;
  readonly received: WireRequest[];
  send(record: unknown): void;
  dropConnection(): void;
  stop(): void;
};

const running: FakeApp[] = [];
const clients: ShorthandAppClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const app of running.splice(0)) app.stop();
});

function socketPath(): string {
  // A named pipe on Windows and a filesystem socket elsewhere, which is what the app
  // itself listens on; `net.connect` takes the same string in both cases.
  return process.platform === "win32"
    ? `\\\\.\\pipe\\shorthand-test-${randomUUID()}`
    : join(tmpdir(), `shorthand-test-${randomUUID()}.sock`);
}

async function startFakeApp(
  options: { hello?: unknown; respond?: (request: WireRequest, app: FakeApp) => void } = {},
): Promise<FakeApp> {
  const path = socketPath();
  const received: WireRequest[] = [];
  const sockets: Socket[] = [];
  const app: FakeApp = {
    path,
    received,
    send(record) {
      for (const socket of sockets) socket.write(`${JSON.stringify(record)}\n`);
    },
    dropConnection() {
      for (const socket of sockets.splice(0)) socket.destroy();
    },
    stop() {
      for (const socket of sockets.splice(0)) socket.destroy();
      server.close();
    },
  };
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    // The client destroying the socket is a case under test; an unhandled ECONNRESET
    // here would fail the run instead of the assertion.
    socket.on("error", () => {});
    socket.write(`${JSON.stringify(options.hello ?? DEFAULT_HELLO)}\n`);
    const reader = new Utf8LineReader((line) => {
      const request = JSON.parse(line) as WireRequest;
      received.push(request);
      options.respond?.(request, app);
    });
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  running.push(app);
  return app;
}

async function scratchEnvironment(discovery?: unknown): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "shorthand-app-client-"));
  const environment: NodeJS.ProcessEnv = process.platform === "win32"
    ? { APPDATA: root }
    : process.platform === "darwin"
      ? { HOME: root }
      : { XDG_CONFIG_HOME: root };
  if (discovery !== undefined) {
    const file = requestSocketDiscoveryPath(environment);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof discovery === "string" ? discovery : JSON.stringify(discovery));
  }
  return environment;
}

async function connectTo(
  app: FakeApp,
  overrides: { handshakeTimeoutMs?: number; requestTimeoutMs?: number } = {},
): Promise<ShorthandAppClient> {
  const environment = await scratchEnvironment({ protocol: 1, path: app.path });
  const client = await ShorthandAppClient.connect({ environment, ...overrides });
  clients.push(client);
  return client;
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function ok(app: FakeApp, request: WireRequest, result: unknown): void {
  app.send({ id: request.id, ok: true, result });
}

describe("requestSocketDiscoveryPath", () => {
  test("names request-socket.json inside the Shorthand config directory", async () => {
    const environment = await scratchEnvironment();
    const path = requestSocketDiscoveryPath(environment);
    expect(path.endsWith(join("Shorthand", "request-socket.json")) || path.endsWith(join("shorthand", "request-socket.json"))).toBe(true);
  });
});

describe("readDiscovery", () => {
  test("returns the protocol and path the app wrote", async () => {
    const environment = await scratchEnvironment({ protocol: 1, path: "/tmp/request.sock" });
    expect(await readDiscovery(environment)).toEqual({ protocol: 1, path: "/tmp/request.sock" });
  });

  test("returns undefined when the file is absent", async () => {
    expect(await readDiscovery(await scratchEnvironment())).toBeUndefined();
  });

  test.each([
    ["not JSON", "{"],
    ["a missing path", { protocol: 1 }],
    ["an empty path", { protocol: 1, path: "" }],
    ["a non-integer protocol", { protocol: 1.5, path: "/tmp/request.sock" }],
    ["a missing protocol", { path: "/tmp/request.sock" }],
  ])("returns undefined for %s", async (_label, written) => {
    expect(await readDiscovery(await scratchEnvironment(written))).toBeUndefined();
  });
});

describe("ShorthandAppClient.connect", () => {
  test("exposes the app version and capabilities from the hello line", async () => {
    const client = await connectTo(await startFakeApp());
    expect(client.appVersion).toBe("0.5.0");
    expect(client.capabilities).toEqual(["credential", "http-fetch", "ws-relay"]);
  });

  test("reports not-running when no discovery file exists", async () => {
    const environment = await scratchEnvironment();
    const error = await ShorthandAppClient.connect({ environment }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppUnavailableError);
    expect((error as AppUnavailableError).reason).toBe("not-running");
  });

  test("reports not-running when the socket the discovery file names is gone", async () => {
    const environment = await scratchEnvironment({ protocol: 1, path: socketPath() });
    const error = await ShorthandAppClient.connect({ environment }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppUnavailableError);
    expect((error as AppUnavailableError).reason).toBe("not-running");
  });

  test("reports not-running when the connection is refused", async () => {
    const environment = await scratchEnvironment({ protocol: 1, path: "/stale/request.sock" });
    const error = await ShorthandAppClient.connect({
      environment,
      // A stale Unix socket file fails with ECONNREFUSED rather than ENOENT, and there is
      // no portable way to leave one behind on Windows, so the failure is injected.
      connect: () => {
        const socket = new Socket();
        queueMicrotask(() => socket.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
        return socket;
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppUnavailableError);
    expect((error as AppUnavailableError).reason).toBe("not-running");
  });

  test("reports too-old with the app version when the app speaks an older protocol", async () => {
    const app = await startFakeApp({ hello: { t: "hello", protocol: 0, version: "0.4.1", capabilities: [] } });
    const environment = await scratchEnvironment({ protocol: 1, path: app.path });
    const error = await ShorthandAppClient.connect({ environment }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppUnavailableError);
    expect((error as AppUnavailableError).reason).toBe("too-old");
    expect((error as AppUnavailableError).appVersion).toBe("0.4.1");
  });

  test("reports protocol when the app speaks a newer protocol", async () => {
    const app = await startFakeApp({ hello: { t: "hello", protocol: 2, version: "0.9.0", capabilities: [] } });
    const environment = await scratchEnvironment({ protocol: 2, path: app.path });
    const error = await ShorthandAppClient.connect({ environment }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppUnavailableError);
    expect((error as AppUnavailableError).reason).toBe("protocol");
    expect((error as AppUnavailableError).appVersion).toBe("0.9.0");
  });

  test("gives up when the app never sends a hello line", async () => {
    const path = socketPath();
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const environment = await scratchEnvironment({ protocol: 1, path });
      const error = await ShorthandAppClient.connect({ environment, handshakeTimeoutMs: 50 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppUnavailableError);
      expect((error as AppUnavailableError).reason).toBe("not-running");
    } finally {
      server.close();
    }
  });
});

describe("ShorthandAppClient.request", () => {
  test("resolves with the result the app returned", async () => {
    const app = await startFakeApp({ respond: (request, self) => ok(self, request, { stream: "s1" }) });
    const client = await connectTo(app);
    const result = await client.request<{ stream: string }>("ws.open", { url: "wss://agent.example/acp" });
    expect(result).toEqual({ stream: "s1" });
    expect(app.received[0]?.method).toBe("ws.open");
    expect(app.received[0]?.params).toEqual({ url: "wss://agent.example/acp" });
    expect(typeof app.received[0]?.id).toBe("string");
  });

  test("rejects with an error carrying the wire code", async () => {
    const app = await startFakeApp({
      respond: (request, self) =>
        self.send({ id: request.id, ok: false, error: { code: "origin_mismatch", message: "url origin does not match the slot" } }),
    });
    const client = await connectTo(app);
    const error = await client.request("http.fetch", { url: "https://elsewhere.example" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: string }).code).toBe("origin_mismatch");
    expect((error as Error).message).toBe("url origin does not match the slot");
  });

  test("delivers an event that arrives before the response to onEvent listeners", async () => {
    const app = await startFakeApp({
      respond: (request, self) => {
        self.send({ t: "http.body", request: request.id, data: "aGk=" });
        self.send({ t: "http.end", request: request.id });
        ok(self, request, { status: 200, headers: {} });
      },
    });
    const client = await connectTo(app);
    const events: AppEvent[] = [];
    const stop = client.onEvent((event) => events.push(event));
    const result = await client.request("http.fetch", { url: "https://api.openai.com/v1/chat/completions" });
    await until(() => events.length >= 2, "both http events");
    expect(result).toEqual({ status: 200, headers: {} });
    expect(events[0]).toEqual({ t: "http.body", request: app.received[0]!.id, data: "aGk=" });
    expect(events[1]).toEqual({ t: "http.end", request: app.received[0]!.id });
    stop();
    app.send({ t: "http.end", request: "later" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(2);
  });

  test("ignores event records it does not understand", async () => {
    const app = await startFakeApp();
    const client = await connectTo(app);
    const events: AppEvent[] = [];
    client.onEvent((event) => events.push(event));
    app.send({ t: "quantum.flux", request: "r1" });
    app.send({ t: "http.body", request: "r1" });
    app.send({ t: "ws.message", stream: "s1", data: "hello" });
    await until(() => events.length >= 1, "the one well-formed event");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([{ t: "ws.message", stream: "s1", data: "hello" }]);
  });

  test("aborting an http.fetch rejects it and tells the app to abort it", async () => {
    const app = await startFakeApp({ respond: () => {} });
    const client = await connectTo(app);
    const controller = new AbortController();
    const pending = client.request("http.fetch", { url: "https://api.openai.com/v1/chat/completions" }, controller.signal);
    await until(() => app.received.length >= 1, "the fetch to reach the app");
    const fetchId = app.received[0]!.id;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await until(() => app.received.some((request) => request.method === "http.abort"), "the abort");
    expect(app.received.find((request) => request.method === "http.abort")?.params).toEqual({ request: fetchId });
  });

  test("aborting a method that is not http.fetch sends no abort", async () => {
    const app = await startFakeApp({ respond: () => {} });
    const client = await connectTo(app);
    const controller = new AbortController();
    const pending = client.request("ws.open", { url: "wss://agent.example/acp" }, controller.signal);
    await until(() => app.received.length >= 1, "the open to reach the app");
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.received.map((request) => request.method)).toEqual(["ws.open"]);
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const app = await startFakeApp({ respond: () => {} });
    const client = await connectTo(app);
    await expect(client.request("http.fetch", {}, AbortSignal.abort())).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.received).toHaveLength(0);
  });

  test("rejects every pending request when the app closes the connection", async () => {
    const app = await startFakeApp({ respond: () => {} });
    const client = await connectTo(app);
    const closes: Array<Error | undefined> = [];
    client.onClose((error) => closes.push(error));
    // Both rejection handlers are attached before the connection drops: waiting on one
    // request at a time would leave the other's rejection unhandled for a turn.
    const first = client.request("credential.status", { slots: [] }).catch((caught: unknown) => caught);
    const second = client.request("http.fetch", { url: "https://api.openai.com" }).catch((caught: unknown) => caught);
    await until(() => app.received.length >= 2, "both requests to reach the app");
    app.dropConnection();
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    await until(() => closes.length === 1, "the close listener");
    await expect(client.request("ws.open", {})).rejects.toThrow();
  });

  test("rejects when the app answers nothing within the request timeout", async () => {
    const app = await startFakeApp({ respond: () => {} });
    const client = await connectTo(app, { requestTimeoutMs: 30 });
    const error = await client.request("credential.status", { slots: [] }).catch((caught: unknown) => caught);
    expect((error as Error & { code?: string }).code).toBe("timeout");
  });

  test("close() notifies listeners and rejects further requests", async () => {
    const client = await connectTo(await startFakeApp());
    const closes: Array<Error | undefined> = [];
    client.onClose((error) => closes.push(error));
    client.close();
    await until(() => closes.length === 1, "the close listener");
    expect(closes[0]).toBeUndefined();
    await expect(client.request("ws.open", {})).rejects.toThrow();
  });
});

describe("credential helpers", () => {
  test("setCredential and clearCredential send the slot the app expects", async () => {
    const app = await startFakeApp({ respond: (request, self) => ok(self, request, {}) });
    const client = await connectTo(app);
    const slot = { kind: "notes-llm", provider: "openai", origin: "https://api.openai.com" } as const;
    await client.setCredential(slot, "sk-test-abc");
    await client.clearCredential(slot);
    expect(app.received.map((request) => request.method)).toEqual(["credential.set", "credential.clear"]);
    expect(app.received[0]?.params).toEqual({ slot, secret: "sk-test-abc" });
    expect(app.received[1]?.params).toEqual({ slot });
  });

  test("credentialStatus returns one status per slot, in order", async () => {
    const slots = [
      { kind: "notes-llm", provider: "anthropic", origin: "https://api.anthropic.com" },
      { kind: "notes-acp", vaultId: "3f9a1c0b2d4e6f80", origin: "wss://agent.example" },
    ] as const;
    const app = await startFakeApp({
      respond: (request, self) =>
        ok(self, request, { statuses: [{ slot: slots[0], status: "configured" }, { slot: slots[1], status: "missing" }] }),
    });
    const client = await connectTo(app);
    expect(await client.credentialStatus(slots)).toEqual(["configured", "missing"]);
    expect(app.received[0]?.params).toEqual({ slots });
  });

  test("credentialStatus rejects a response that does not answer every slot", async () => {
    const app = await startFakeApp({ respond: (request, self) => ok(self, request, { statuses: [] }) });
    const client = await connectTo(app);
    const error = await client
      .credentialStatus([{ kind: "notes-acp", vaultId: "3f9a1c0b2d4e6f80", origin: "wss://agent.example" }])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("malformed status list");
  });
});
