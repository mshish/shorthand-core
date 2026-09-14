import type { AppClientLike, AppCredentialSlot, AppEvent } from "./client.js";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** The code the WebSocket API reports when the peer closed without sending one. */
const NO_STATUS_RECEIVED = 1005;
/** The code the WebSocket API reports for a connection that failed or ended abnormally. */
const ABNORMAL_CLOSURE = 1006;

/**
 * What the shim hands its listeners. The shapes match the browser events the ACP SDK reads:
 * it takes `data` off a message event and passes an error event straight to the stream it
 * fails, so an error carries a real `Error` rather than only prose.
 */
export type AppWebSocketEvent =
  | Readonly<{ type: "open" }>
  | Readonly<{ type: "message"; data: string }>
  | Readonly<{ type: "close"; code: number; reason: string; wasClean: boolean }>
  | Readonly<{ type: "error"; message: string; error: Error }>;

/**
 * The relay's instance surface. The SDK's `WebSocketLike` marks every member optional
 * because it also accepts Node's `ws`; this says which half of that shape is actually here.
 */
export interface AppWebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: AppWebSocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: AppWebSocketEvent) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Assignable to the SDK's `WebSocketConstructor`. The third `options` parameter is absent
 * on purpose: it carries request headers, and the app owns the headers on this connection —
 * it strips client-supplied authorization and attaches the slot's secret itself.
 */
export interface AppWebSocketConstructor {
  new (url: string, protocols?: string | string[]): AppWebSocketLike;
}

function normaliseProtocols(protocols?: string | string[]): string[] {
  if (protocols === undefined) return [];
  return typeof protocols === "string" ? [protocols] : [...protocols];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A `WebSocket` class whose frames travel through the Shorthand app, so an ACP agent's
 * token stays in the app's keyring: core asks for a relay, the app dials the agent with the
 * secret attached, and every frame after that is a `ws.send` or a `ws.message` event.
 *
 * Pass the result to the ACP SDK's `createWebSocketStream(url, { WebSocket })`.
 */
export function createAppWebSocketConstructor(client: AppClientLike, slot: AppCredentialSlot): AppWebSocketConstructor {
  return class AppWebSocket implements AppWebSocketLike {
    #readyState: number = CONNECTING;
    #stream: string | undefined;
    /** Set when `close()` is called before the relay exists, and sent as soon as it does. */
    #pendingClose: Readonly<{ code: number; reason: string }> | undefined;
    /**
     * Events that arrived before `ws.open` resolved. The app can answer and forward the
     * agent's first frame in one socket read, which the client delivers synchronously —
     * before the `await` that learns the stream id resumes. Frames buffered here belong to
     * some stream; which one is only decidable once that id is known.
     */
    readonly #buffered: AppEvent[] = [];
    readonly #listeners = new Map<string, Set<(event: AppWebSocketEvent) => void>>();
    readonly #detach: Array<() => void> = [];

    constructor(url: string, protocols?: string | string[]) {
      this.#detach.push(client.onEvent((event) => this.#onEvent(event)));
      // The app's process is the peer here: if the request socket goes, so has the relay,
      // and without this the ACP stream would wait on frames that can never arrive.
      this.#detach.push(client.onClose(() => this.#abandon("The connection to the Shorthand app closed.")));
      client
        .request<{ stream?: unknown }>("ws.open", { slot, url, protocols: normaliseProtocols(protocols) })
        .then(
          (result) => this.#onOpened(result?.stream),
          (error: unknown) => this.#abandon(errorMessage(error)),
        );
    }

    get readyState(): number {
      return this.#readyState;
    }

    addEventListener(type: string, listener: (event: AppWebSocketEvent) => void): void {
      const listeners = this.#listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.#listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: AppWebSocketEvent) => void): void {
      this.#listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
      if (this.#readyState === CONNECTING) {
        // What the WebSocket API does: a send before `open` is a caller bug, not a frame to
        // queue, and the ACP transport waits for `open` precisely because of this rule.
        throw new Error("Cannot send on a Shorthand app WebSocket that is still connecting.");
      }
      const stream = this.#stream;
      // Closing or closed discards, as the WebSocket API does.
      if (stream === undefined || this.#readyState !== OPEN) return;
      void client
        .request("ws.send", { stream, data })
        .catch((error: unknown) => this.#abandon(errorMessage(error)));
    }

    close(code?: number, reason?: string): void {
      if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
      const request = { code: code ?? 1000, reason: reason ?? "" };
      this.#readyState = CLOSING;
      const stream = this.#stream;
      if (stream === undefined) {
        this.#pendingClose = request;
        return;
      }
      this.#sendClose(stream, request);
    }

    #sendClose(stream: string, request: Readonly<{ code: number; reason: string }>): void {
      // The `ws.closed` event, not this answer, is what moves the socket to CLOSED: it
      // carries the code the relay actually closed with.
      void client
        .request("ws.close", { stream, ...request })
        .catch((error: unknown) => this.#abandon(errorMessage(error)));
    }

    #onOpened(stream: unknown): void {
      if (typeof stream !== "string") {
        this.#abandon("The Shorthand app opened a WebSocket relay without a stream id.");
        return;
      }
      this.#stream = stream;
      const pendingClose = this.#pendingClose;
      if (pendingClose !== undefined) {
        this.#pendingClose = undefined;
        this.#buffered.length = 0;
        this.#sendClose(stream, pendingClose);
        return;
      }
      this.#readyState = OPEN;
      this.#dispatch({ type: "open" });
      // Drained after `open` so a listener never sees a frame from a socket it has not been
      // told is open.
      for (const event of this.#buffered.splice(0)) this.#deliver(event);
    }

    #onEvent(event: AppEvent): void {
      if (!("stream" in event)) return;
      if (this.#stream === undefined) {
        this.#buffered.push(event);
        return;
      }
      if (event.stream !== this.#stream) return;
      this.#deliver(event);
    }

    #deliver(event: AppEvent): void {
      if (!("stream" in event) || event.stream !== this.#stream || this.#readyState === CLOSED) return;
      switch (event.t) {
        case "ws.message":
          this.#dispatch({ type: "message", data: event.data });
          return;
        case "ws.closed":
          this.#shutdown({
            type: "close",
            code: event.code ?? NO_STATUS_RECEIVED,
            reason: event.reason ?? "",
            wasClean: true,
          });
          return;
        case "ws.error":
          // Treated as terminal, as the WebSocket API treats it: an error event is always
          // followed by a close, and a relay that has failed may send nothing further.
          this.#abandon(event.message);
          return;
      }
    }

    /** Ends the socket the way a failure ends a real one: an error event, then a close. */
    #abandon(failure: string): void {
      this.#shutdown({ type: "close", code: ABNORMAL_CLOSURE, reason: "", wasClean: false }, failure);
    }

    #shutdown(event: Extract<AppWebSocketEvent, { type: "close" }>, failure?: string): void {
      if (this.#readyState === CLOSED) return;
      this.#readyState = CLOSED;
      this.#buffered.length = 0;
      for (const detach of this.#detach.splice(0)) detach();
      if (failure !== undefined) this.#dispatch({ type: "error", message: failure, error: new Error(failure) });
      this.#dispatch(event);
    }

    #dispatch(event: AppWebSocketEvent): void {
      // A copy: a listener that removes itself must not disturb this delivery.
      for (const listener of [...(this.#listeners.get(event.type) ?? [])]) listener(event);
    }
  };
}
