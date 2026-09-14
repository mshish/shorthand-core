import { describe, expect, test } from "bun:test";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import type { AppCredentialSlot } from "../src/app/client.js";
import { createAppWebSocketConstructor, type AppWebSocketEvent, type AppWebSocketLike } from "../src/app/websocket.js";
import { FakeAppClient } from "./fixtures/fake-app-client.js";

const SLOT: AppCredentialSlot = { kind: "notes-acp", vaultId: "3f9a1c2b4d5e6f70", origin: "wss://agent.example" };
const URL_UNDER_TEST = "wss://agent.example/acp";

type Recorded = Readonly<{ type: string; event: AppWebSocketEvent }>;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Records every event type the ACP SDK subscribes to, in the order they are dispatched. */
function record(socket: AppWebSocketLike): Recorded[] {
  const events: Recorded[] = [];
  for (const type of ["open", "message", "close", "error"]) {
    socket.addEventListener(type, (event) => {
      events.push({ type, event });
    });
  }
  return events;
}

function types(events: readonly Recorded[]): string[] {
  return events.map((entry) => entry.type);
}

describe("createAppWebSocketConstructor", () => {
  test("sends ws.open with the slot, url and protocols, and starts CONNECTING", () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);

    const socket = new AppWebSocket(URL_UNDER_TEST, ["acp"]);

    expect(client.lastSent("ws.open")?.params).toEqual({ slot: SLOT, url: URL_UNDER_TEST, protocols: ["acp"] });
    expect(socket.readyState).toBe(0);
  });

  test.each([
    ["no protocols", undefined, []],
    ["a single protocol string", "acp", ["acp"]],
  ])("normalises %s", (_label, protocols, expected) => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);

    new AppWebSocket(URL_UNDER_TEST, protocols);

    expect(client.lastSent("ws.open")?.params.protocols).toEqual(expected);
  });

  test("fires open and moves to OPEN once the app answers with a stream id", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);

    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    expect(types(events)).toEqual(["open"]);
    expect(socket.readyState).toBe(1);
  });

  test("sends ws.send for each frame", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    socket.send('{"jsonrpc":"2.0"}');

    expect(client.lastSent("ws.send")?.params).toEqual({ stream: "s1", data: '{"jsonrpc":"2.0"}' });
  });

  test("turns ws.message into a message event carrying the data", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    client.emit({ t: "ws.message", stream: "s1", data: "hello" });

    expect(types(events)).toEqual(["open", "message"]);
    expect(events[1]?.event).toMatchObject({ data: "hello" });
  });

  test("delivers messages that arrive before the open result is observed", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);

    // One turn, as a single socket read would arrive: the app answers `ws.open` and the
    // agent's first frame follows before anything awaiting that answer can resume.
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    client.emit({ t: "ws.message", stream: "s1", data: "first" });
    await flush();

    expect(types(events)).toEqual(["open", "message"]);
    expect(events[1]?.event).toMatchObject({ data: "first" });
  });

  test("ignores events belonging to another stream", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    client.emit({ t: "ws.message", stream: "s2", data: "not mine" });

    expect(types(events)).toEqual(["open"]);
  });

  test("close() sends ws.close and ws.closed completes the transition 0 -> 1 -> 3", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);
    const states = [socket.readyState];
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();
    states.push(socket.readyState);

    socket.close(1000, "done");
    expect(client.lastSent("ws.close")?.params).toEqual({ stream: "s1", code: 1000, reason: "done" });

    client.emit({ t: "ws.closed", stream: "s1", code: 1000, reason: "done" });
    states.push(socket.readyState);

    expect(states).toEqual([0, 1, 3]);
    expect(types(events)).toEqual(["open", "close"]);
    expect(events[1]?.event).toMatchObject({ code: 1000, reason: "done", wasClean: true });
    expect(client.eventListenerCount).toBe(0);
  });

  test("a peer-initiated ws.closed fires close without a ws.close request", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    client.emit({ t: "ws.closed", stream: "s1" });

    expect(client.lastSent("ws.close")).toBeUndefined();
    expect(socket.readyState).toBe(3);
    expect(events[1]?.event).toMatchObject({ code: 1005 });
  });

  test("close() before the stream opens still closes it once the app answers", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);

    socket.close();
    expect(socket.readyState).toBe(2);
    expect(client.lastSent("ws.close")).toBeUndefined();

    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    expect(client.lastSent("ws.close")?.params).toEqual({ stream: "s1", code: 1000, reason: "" });
  });

  test("a rejected ws.open fires error then close", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);

    client.fail(client.lastSent("ws.open")!.id, "credential_missing", "No secret is stored for this agent.");
    await flush();

    expect(types(events)).toEqual(["error", "close"]);
    expect(events[0]?.event).toMatchObject({ message: "No secret is stored for this agent." });
    expect(events[1]?.event).toMatchObject({ code: 1006, wasClean: false });
    expect(socket.readyState).toBe(3);
    expect(client.eventListenerCount).toBe(0);
  });

  test("ws.error fires error and then close, since the relay may send nothing further", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    client.emit({ t: "ws.error", stream: "s1", message: "the agent hung up" });

    expect(types(events)).toEqual(["open", "error", "close"]);
    expect(events[1]?.event).toMatchObject({ message: "the agent hung up" });
    expect(socket.readyState).toBe(3);
    expect(client.eventListenerCount).toBe(0);
  });

  test("losing the connection to the app closes the socket", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const events = record(socket);
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    client.close();

    expect(types(events)).toEqual(["open", "error", "close"]);
    expect(socket.readyState).toBe(3);
  });

  test("removeEventListener stops delivery", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);
    const seen: AppWebSocketEvent[] = [];
    const listener = (event: AppWebSocketEvent): void => {
      seen.push(event);
    };
    socket.addEventListener("message", listener);
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    client.emit({ t: "ws.message", stream: "s1", data: "one" });
    socket.removeEventListener("message", listener);
    client.emit({ t: "ws.message", stream: "s1", data: "two" });

    expect(seen).toHaveLength(1);
  });

  test("send() before open throws, and after close is discarded", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);
    const socket = new AppWebSocket(URL_UNDER_TEST);

    expect(() => socket.send("too early")).toThrow();

    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();
    client.emit({ t: "ws.closed", stream: "s1", code: 1000, reason: "" });
    socket.send("too late");

    expect(client.lastSent("ws.send")).toBeUndefined();
  });

  test("drives an ACP WebSocket stream end to end", async () => {
    const client = new FakeAppClient();
    const AppWebSocket = createAppWebSocketConstructor(client, SLOT);

    // The SDK's own transport is the consumer B4 hands this to, so it is what proves the
    // shim satisfies `WebSocketConstructor` in more than name.
    const stream = createWebSocketStream(URL_UNDER_TEST, { WebSocket: AppWebSocket, protocols: ["acp"] });
    client.respond(client.lastSent("ws.open")!.id, { stream: "s1" });
    await flush();

    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(JSON.parse(client.lastSent("ws.send")!.params.data as string)).toMatchObject({ id: 1, method: "initialize" });

    const reader = stream.readable.getReader();
    client.emit({ t: "ws.message", stream: "s1", data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) });
    const received = await reader.read();
    expect(received.value).toMatchObject({ id: 1, result: {} });

    await reader.cancel();
    expect(client.lastSent("ws.close")?.params).toMatchObject({ stream: "s1" });
  });
});
