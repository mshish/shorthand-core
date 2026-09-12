import type { AppClientLike, AppCredentialSlot } from "./client.js";

/**
 * Statuses the `Response` constructor refuses to pair with a body, so a body stream handed
 * to it for one of these throws instead of reaching the caller. `205` is in the list for
 * the same reason `204` is, even though only `204` and `304` are likely from an LLM.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

type FetchOk = Readonly<{ status?: unknown; headers?: unknown }>;

/**
 * The wire contract's own auth-injection rule (CONTRACT.md §5.4) strips these four and then
 * sets `authorization` or `x-api-key` itself from the slot's secret — so this shim strips
 * them first rather than relying on the app to. The concrete case that made it not optional:
 * the AI SDK provider factories refuse to build without an `apiKey` string, so they are handed
 * `APP_MANAGED_API_KEY`, and that placeholder becomes a literal `authorization: Bearer
 * managed-by-shorthand` header that would otherwise cross the socket in place of a secret.
 */
const STRIPPED_REQUEST_HEADERS = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The request was aborted.");
}

/** `code: "closed"` is the code the client gives its own failures, so a caller can branch on one. */
function connectionLost(error?: Error): Error {
  if (error !== undefined) return error;
  return Object.assign(new Error("The connection to the Shorthand app closed before the response body ended."), {
    code: "closed",
  });
}

/** Header values that are not strings are a malformed answer, not a header worth guessing at. */
function responseHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return headers;
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") headers[name] = headerValue;
  }
  return headers;
}

/**
 * A `fetch` that makes its calls from inside the Shorthand app, so the credential the call
 * needs stays in the app's keyring: core sends the request, the app attaches the secret and
 * performs the network I/O, and the response comes back over the request socket.
 *
 * The result is `typeof globalThis.fetch`, which is what the AI SDK provider factories and
 * the ACP SDK's `createHttpStream` accept, so nothing downstream has to know the difference.
 */
export function createAppFetch(client: AppClientLike, slot: AppCredentialSlot): typeof globalThis.fetch {
  const appFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    // `Headers` already lower-cases every name, which is the case the wire contract asks for.
    for (const [name, value] of request.headers) {
      if (STRIPPED_REQUEST_HEADERS.has(name)) continue;
      headers[name] = value;
    }
    const body = Buffer.from(await request.arrayBuffer());

    const { id, result } = client.startRequest<FetchOk>(
      "http.fetch",
      {
        slot,
        url: request.url,
        method: request.method,
        headers,
        ...(body.byteLength > 0 ? { body: body.toString("base64") } : {}),
      },
      request.signal,
    );

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cleanups: Array<() => void> = [];
    let finished = false;
    /** True the first time it is called, so the stream is closed, errored or cancelled once. */
    const finish = (): boolean => {
      if (finished) return false;
      finished = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      return true;
    };
    const abortUpstream = (): void => {
      // Fire and forget: the app has nothing to say about an abort, and a failure here
      // means the connection is already gone, which the caller learns from the body.
      void client.request("http.abort", { request: id }).catch(() => undefined);
    };

    const bodyStream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
      },
      cancel: () => {
        // A consumer that stops reading — an LLM stream the user cancelled — leaves the app
        // pushing a body at nobody until it is told to stop.
        if (finish()) abortUpstream();
      },
    });

    // Subscribing after the send rather than before it is safe, and is what makes the id
    // available: the client only delivers events while reading the socket, which cannot
    // interleave with the synchronous code between these two statements.
    cleanups.push(
      client.onEvent((event) => {
        if (!("request" in event) || event.request !== id) return;
        switch (event.t) {
          case "http.body":
            controller?.enqueue(Buffer.from(event.data, "base64"));
            return;
          case "http.end":
            if (finish()) controller?.close();
            return;
          case "http.error":
            if (finish()) controller?.error(new Error(event.message));
            return;
        }
      }),
    );
    // A body ends with an event, and a dead connection sends none: the client rejects
    // pending requests when it shuts down, but a body already streaming has no request left
    // to reject, and there is no timeout anywhere below this to rescue the reader.
    cleanups.push(
      client.onClose((error) => {
        if (finish()) controller?.error(connectionLost(error));
      }),
    );

    const fail = (error: unknown): never => {
      if (finish()) controller?.error(error instanceof Error ? error : new Error(errorMessage(error)));
      throw error;
    };

    const ok = await result.catch(fail);
    if (typeof ok?.status !== "number") {
      return fail(new Error("The Shorthand app answered http.fetch without a status."));
    }

    const status = ok.status;
    if (request.method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
      // Nothing will read this stream and no chunk is coming, so the subscription ends here
      // rather than waiting on an `http.end` the app is under no obligation to send.
      finish();
      return new Response(null, { status, headers: responseHeaders(ok.headers) });
    }

    const signal = request.signal;
    const onAbort = (): void => {
      if (finish()) {
        controller?.error(abortReason(signal));
        abortUpstream();
      }
    };
    // The client stops watching the signal once the response arrives, so from here the
    // abort that matters — the one during a long streamed body — is this shim's to send.
    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
    // An abort raised between the client settling the request and this continuation resuming
    // is watched by neither side, and the listener above only fires on aborts still to come.
    if (signal.aborted) onAbort();

    return new Response(bodyStream, { status, headers: responseHeaders(ok.headers) });
  };
  // `typeof globalThis.fetch` on this runtime carries `preconnect`, and the ACP SDK's
  // `createHttpStream` asks for that exact type. It is a hint to warm a connection this
  // process will never make — the app holds the socket — so it does nothing here.
  return Object.assign(appFetch, { preconnect: (): void => undefined });
}
