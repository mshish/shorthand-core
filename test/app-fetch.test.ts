import { describe, expect, test } from "bun:test";
import type { HttpStreamOptions } from "@agentclientprotocol/sdk/experimental/http-client";
import type { AppCredentialSlot } from "../src/app/client.js";
import { createAppFetch } from "../src/app/fetch.js";
import { FakeAppClient } from "./fixtures/fake-app-client.js";

const SLOT: AppCredentialSlot = { kind: "notes-llm", provider: "openai", origin: "https://api.openai.com" };
const URL_UNDER_TEST = "https://api.openai.com/v1/chat/completions";

/** Lets the shim's own `await` on the request body run before the test inspects the wire. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("createAppFetch", () => {
  test("sends http.fetch with the slot, lower-case headers and a base64 body", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "1" },
      body: JSON.stringify({ model: "gpt-5" }),
    });
    await flush();

    const sent = client.lastSent("http.fetch");
    expect(sent?.params.slot).toEqual(SLOT);
    expect(sent?.params.url).toBe(URL_UNDER_TEST);
    expect(sent?.params.method).toBe("POST");
    const headers = sent?.params.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(Object.keys(headers).map((name) => name.toLowerCase()));
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-custom"]).toBe("1");
    expect(sent?.params.body).toBe(base64(JSON.stringify({ model: "gpt-5" })));

    client.respond(sent!.id, { status: 200, headers: {} });
    client.emit({ t: "http.end", request: sent!.id });
    await pending;
  });

  test("strips the SDK's placeholder auth headers before sending", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST, {
      headers: {
        Authorization: "Bearer managed-by-shorthand",
        "X-Api-Key": "managed-by-shorthand",
        Cookie: "session=abc",
        "Proxy-Authorization": "Basic xyz",
        "X-Custom": "1",
      },
    });
    await flush();

    const headers = client.lastSent("http.fetch")?.params.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("x-api-key");
    expect(headers).not.toHaveProperty("cookie");
    expect(headers).not.toHaveProperty("proxy-authorization");
    expect(headers["x-custom"]).toBe("1");

    const sent = client.lastSent("http.fetch")!;
    client.respond(sent.id, { status: 200, headers: {} });
    client.emit({ t: "http.end", request: sent.id });
    await pending;
  });

  test("accepts a Request object and omits the body when there is none", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(new Request(URL_UNDER_TEST, { headers: { accept: "text/event-stream" } }));
    await flush();

    const sent = client.lastSent("http.fetch");
    expect(sent?.params.method).toBe("GET");
    expect(sent?.params).not.toHaveProperty("body");
    expect((sent?.params.headers as Record<string, string>).accept).toBe("text/event-stream");

    client.respond(sent!.id, { status: 200, headers: {} });
    client.emit({ t: "http.end", request: sent!.id });
    await pending;
  });

  test("answers with the status and headers from the ok result", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST);
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    client.respond(id, { status: 201, headers: { "content-type": "application/json", "x-request-id": "abc" } });
    client.emit({ t: "http.end", request: id });

    const response = await pending;
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("abc");
    expect(await response.text()).toBe("");
  });

  test("concatenates http.body chunks in order, including chunks delivered in the same turn as the response", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST);
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    // One turn, as a single socket read would arrive: the response line and the first
    // chunks reach the client before anything awaiting the response can resume.
    client.respond(id, { status: 200, headers: {} });
    client.emit({ t: "http.body", request: id, data: base64("data: one\n") });
    client.emit({ t: "http.body", request: id, data: base64("data: two\n") });

    const response = await pending;
    client.emit({ t: "http.body", request: id, data: base64("data: three\n") });
    client.emit({ t: "http.end", request: id });

    expect(await response.text()).toBe("data: one\ndata: two\ndata: three\n");
  });

  test("rejects the body read when the app reports http.error", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST);
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    client.respond(id, { status: 200, headers: {} });
    const response = await pending;
    client.emit({ t: "http.body", request: id, data: base64("partial") });
    client.emit({ t: "http.error", request: id, message: "upstream reset the connection" });

    const error = await caught(response.text());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("upstream reset the connection");
  });

  test("rejects when the app rejects the request, carrying the wire code", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST);
    await flush();
    client.fail(client.lastSent("http.fetch")!.id, "origin_mismatch", "The URL is not the slot's origin.");

    const error = await caught(pending);
    expect((error as Error & { code?: string }).code).toBe("origin_mismatch");
    expect(client.eventListenerCount).toBe(0);
  });

  test("aborting before the response reaches the app as http.abort", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const controller = new AbortController();
    const pending = fetch(URL_UNDER_TEST, { signal: controller.signal });
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    controller.abort();

    const error = await caught(pending);
    expect((error as Error).name).toBe("AbortError");
    expect(client.lastSent("http.abort")?.params).toEqual({ request: id });
    expect(client.eventListenerCount).toBe(0);
  });

  test("aborting mid-body sends http.abort and errors the body stream", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const controller = new AbortController();
    const pending = fetch(URL_UNDER_TEST, { signal: controller.signal });
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    client.respond(id, { status: 200, headers: {} });
    const response = await pending;
    client.emit({ t: "http.body", request: id, data: base64("half a stream") });

    controller.abort();

    // The real client only aborts a request it is still waiting on, so the shim owns this
    // window: without its own abort the app would keep streaming to nobody.
    expect(client.sent.filter((request) => request.method === "http.abort")).toEqual([
      { id: expect.any(String), method: "http.abort", params: { request: id } },
    ]);
    const error = await caught(response.text());
    expect((error as Error).name).toBe("AbortError");
    expect(client.eventListenerCount).toBe(0);
  });

  test("an abort raised while the response is being handed back still reaches the app", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const controller = new AbortController();
    const pending = fetch(URL_UNDER_TEST, { signal: controller.signal });
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    // Both in one turn, so the abort lands after the client has settled the request and
    // before the shim resumes: the window neither side is watching the signal.
    client.respond(id, { status: 200, headers: {} });
    controller.abort();

    const response = await pending;
    expect(client.lastSent("http.abort")?.params).toEqual({ request: id });
    const error = await caught(response.text());
    expect((error as Error).name).toBe("AbortError");
    expect(client.eventListenerCount).toBe(0);
  });

  test("losing the connection to the app mid-body rejects the body read", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST);
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    client.respond(id, { status: 200, headers: {} });
    const response = await pending;
    client.emit({ t: "http.body", request: id, data: base64("half a stream") });

    // No `http.error` follows a dead connection, and the request itself is long settled, so
    // without the close listener this read would wait for a chunk that cannot arrive.
    client.close();

    const error = await caught(response.text());
    expect((error as Error & { code?: string }).code).toBe("closed");
    expect(client.eventListenerCount).toBe(0);
    expect(client.closeListenerCount).toBe(0);
  });

  test("cancelling the body sends http.abort", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST);
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    client.respond(id, { status: 200, headers: {} });
    const response = await pending;
    await response.body!.cancel();

    expect(client.lastSent("http.abort")?.params).toEqual({ request: id });
    expect(client.eventListenerCount).toBe(0);
  });

  test.each([
    ["204", 204, "GET"],
    ["304", 304, "GET"],
    ["a HEAD request", 200, "HEAD"],
  ])("gives %s a null body", async (_label, status, method) => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST, { method });
    await flush();
    const id = client.lastSent("http.fetch")!.id;
    // Deliberately no `http.end`: a response with no body has nothing left to wait for.
    client.respond(id, { status, headers: { "content-length": "12" } });

    const response = await pending;
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(client.eventListenerCount).toBe(0);
    expect(client.closeListenerCount).toBe(0);
  });

  test("stops listening for events once the body ends", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST);
    await flush();
    expect(client.eventListenerCount).toBe(1);
    const id = client.lastSent("http.fetch")!.id;
    client.respond(id, { status: 200, headers: {} });
    client.emit({ t: "http.end", request: id });
    await (await pending).text();

    expect(client.eventListenerCount).toBe(0);
  });

  test("ignores events belonging to another in-flight request", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const first = fetch(URL_UNDER_TEST);
    await flush();
    const firstId = client.lastSent("http.fetch")!.id;
    const second = fetch(URL_UNDER_TEST);
    await flush();
    const secondId = client.lastSent("http.fetch")!.id;
    expect(secondId).not.toBe(firstId);

    client.respond(firstId, { status: 200, headers: {} });
    client.respond(secondId, { status: 200, headers: {} });
    client.emit({ t: "http.body", request: secondId, data: base64("second") });
    client.emit({ t: "http.body", request: firstId, data: base64("first") });
    client.emit({ t: "http.end", request: firstId });
    client.emit({ t: "http.end", request: secondId });

    expect(await (await first).text()).toBe("first");
    expect(await (await second).text()).toBe("second");
  });

  test("satisfies the fetch the ACP SDK's HTTP transport asks for", () => {
    // `HttpStreamOptions.fetch` is `typeof globalThis.fetch`, which on this runtime carries
    // members a bare function does not; the check that matters here is the typecheck.
    const options: HttpStreamOptions = { fetch: createAppFetch(new FakeAppClient(), SLOT) };

    expect(options.fetch).toBeInstanceOf(Function);
  });

  test("rejects a response the app describes without a status", async () => {
    const client = new FakeAppClient();
    const fetch = createAppFetch(client, SLOT);

    const pending = fetch(URL_UNDER_TEST);
    await flush();
    client.respond(client.lastSent("http.fetch")!.id, { headers: {} });

    const error = await caught(pending);
    expect(error).toBeInstanceOf(Error);
    expect(client.eventListenerCount).toBe(0);
  });
});
