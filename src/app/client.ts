import { randomUUID } from "node:crypto";
import { connect as connectSocket, type Socket } from "node:net";
import type { LlmProviderId } from "../agent/llm-credentials.js";
import { Utf8LineReader } from "../ndjson.js";
import { readDiscovery } from "./discovery.js";

/**
 * The client half of the Shorthand app's request socket: the channel core uses to ask the
 * app to hold provider secrets and to make the authenticated calls those secrets unlock,
 * so a key never has to exist in core's process or on the plugin's disk.
 *
 * This is a second socket, not a message on the follow-stream, because the follow-stream
 * carries transcript records only: it has no request ids to correlate a reply with, and
 * its parser drops any record without a `session` field (`src/stream/client.ts:349`) — so
 * a credential reply sent over it would be discarded before any caller saw it. Widening
 * that parser would make every transcript consumer responsible for records that are none
 * of its business.
 */
export const APP_PROTOCOL_VERSION = 1;

/**
 * Identifies the secret a call should use. The app derives the keyring entry from these
 * fields, so the shapes are wire contract: changing one orphans a stored secret.
 */
export type AppCredentialSlot =
  | Readonly<{ kind: "notes-llm"; provider: LlmProviderId; origin: string }>
  | Readonly<{ kind: "notes-acp"; vaultId: string; origin: string }>;

/** `unavailable` means the app could not reach the keyring at all, not that the slot is empty. */
export type AppCredentialStatus = "configured" | "missing" | "unavailable";

export type AppUnavailableReason = "not-running" | "too-old" | "protocol";

/**
 * Why the app cannot serve requests. `reason` exists so a consumer can tell the user
 * something actionable — upgrade the app, upgrade the plugin, or start the app — without
 * parsing a message.
 */
export class AppUnavailableError extends Error {
  readonly reason: AppUnavailableReason;
  readonly appVersion?: string;

  constructor(reason: AppUnavailableReason, message: string, appVersion?: string) {
    super(message);
    this.name = "AppUnavailableError";
    this.reason = reason;
    // `exactOptionalPropertyTypes` rejects an explicit `undefined` here, and a consumer
    // checking `"appVersion" in error` should not see the key when no hello line arrived.
    if (appVersion !== undefined) this.appVersion = appVersion;
  }
}

/**
 * Server-pushed records that carry no response id: the streaming half of `http.fetch` and
 * the whole of the `ws.*` relay.
 */
export type AppEvent =
  | Readonly<{ t: "http.body"; request: string; data: string }>
  | Readonly<{ t: "http.end"; request: string }>
  | Readonly<{ t: "http.error"; request: string; message: string }>
  | Readonly<{ t: "ws.message"; stream: string; data: string }>
  | Readonly<{ t: "ws.closed"; stream: string; code?: number; reason?: string }>
  | Readonly<{ t: "ws.error"; stream: string; message: string }>;

export type ShorthandAppClientOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  connect?: (path: string) => Socket;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}>;

/**
 * The surface a caller needs. Exported as an interface so consumers that only orchestrate
 * calls — the `fetch` and `WebSocket` shims built on top — can be tested against a fake
 * without a socket, a discovery file, or a running app.
 */
export interface AppClientLike {
  readonly appVersion: string;
  readonly capabilities: readonly string[];
  request<T = unknown>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  startRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Readonly<{ id: string; result: Promise<T> }>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): void;
  setCredential(slot: AppCredentialSlot, secret: string): Promise<void>;
  clearCredential(slot: AppCredentialSlot): Promise<void>;
  credentialStatus(slots: readonly AppCredentialSlot[]): Promise<readonly AppCredentialStatus[]>;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Mirrors the app's own per-request bound. Duplicating it here is what covers the one
 * failure the socket's `close` handler cannot: an app that is alive and connected but
 * never answers, which otherwise leaves the caller's promise pending forever.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;

type Hello = Readonly<{ version: string; capabilities: readonly string[] }>;

type Pending = Readonly<{
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  dispose: () => void;
}>;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Rejections carry the wire `code` so callers can branch on it without matching prose. */
function wireError(code: unknown, message: unknown): Error {
  const error = new Error(isString(message) ? message : "The Shorthand app rejected the request.");
  if (isString(code)) Object.assign(error, { code });
  return error;
}

/**
 * The same `code` shape as a wire error, for failures this client decides on its own.
 * `timeout` is the wire code with the same meaning; `closed` and `malformed` are codes no
 * server ever sends, so a caller matching on wire codes cannot confuse a client-side verdict
 * with one the app made — `bad_request`, in particular, is what the app sends about a
 * request *it* rejected, not what this client should synthesize about a reply it rejected.
 */
function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The structural identity of a slot, independent of property order — two slots are the same
 * credential iff this key matches. Used to correlate a `credential.status` reply's entries
 * with the slots that were requested, because the wire contract never states that reply order
 * mirrors request order and echoes the slot in each entry precisely so a client does not have
 * to assume it does.
 */
function slotKey(slot: AppCredentialSlot): string {
  return slot.kind === "notes-llm" ? `notes-llm:${slot.provider}:${slot.origin}` : `notes-acp:${slot.vaultId}:${slot.origin}`;
}

/** Same key as `slotKey`, built defensively from an untrusted wire value instead of a typed slot. */
function wireSlotKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, provider, vaultId, origin } = value as Record<string, unknown>;
  if (!isString(origin)) return undefined;
  if (kind === "notes-llm" && isString(provider)) return `notes-llm:${provider}:${origin}`;
  if (kind === "notes-acp" && isString(vaultId)) return `notes-acp:${vaultId}:${origin}`;
  return undefined;
}

function abortError(signal: AbortSignal): Error {
  // `signal.reason` is what `fetch` rejects with, and B2 wraps this client in a `fetch`
  // shim, so a caller's own abort reason has to survive the trip.
  return signal.reason instanceof Error ? signal.reason : new Error("The request was aborted.");
}

/**
 * Turns a record with no `id` into an `AppEvent`, or drops it.
 *
 * Unrecognized `t` values are events from a newer app. Forwarding them unchecked would
 * hand a listener a record missing the fields `AppEvent` promises, which fails inside the
 * listener rather than here.
 */
function parseEvent(record: Record<string, unknown>): AppEvent | undefined {
  const { t, request, stream, data, message, code, reason } = record;
  switch (t) {
    case "http.body":
      return isString(request) && isString(data) ? { t, request, data } : undefined;
    case "http.end":
      return isString(request) ? { t, request } : undefined;
    case "http.error":
      return isString(request) && isString(message) ? { t, request, message } : undefined;
    case "ws.message":
      return isString(stream) && isString(data) ? { t, stream, data } : undefined;
    case "ws.closed":
      return isString(stream)
        ? {
          t,
          stream,
          ...(typeof code === "number" ? { code } : {}),
          ...(isString(reason) ? { reason } : {}),
        }
        : undefined;
    case "ws.error":
      return isString(stream) && isString(message) ? { t, stream, message } : undefined;
    default:
      return undefined;
  }
}

export class ShorthandAppClient implements AppClientLike {
  /**
   * Reads the discovery file, connects, and completes the hello handshake. Every way this
   * can fail — no file, no socket, a protocol neither side shares — arrives as an
   * `AppUnavailableError`, because the caller's next move is the same in each case: tell
   * the user, and carry on without the app.
   */
  static async connect(options: ShorthandAppClientOptions = {}): Promise<ShorthandAppClient> {
    const discovery = await readDiscovery(options.environment);
    if (discovery === undefined) {
      throw new AppUnavailableError("not-running", "Shorthand is not running: it has published no request socket.");
    }

    const open = options.connect ?? ((path: string) => connectSocket(path));
    const client = new ShorthandAppClient(open(discovery.path), options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      await client.#completeHandshake(options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  readonly #socket: Socket;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, Pending>();
  readonly #eventListeners = new Set<(event: AppEvent) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  /** Cleared the moment the handshake settles, so `undefined` means "already decided". */
  #settleHello: { resolve: (hello: Hello) => void; reject: (error: Error) => void } | undefined;
  readonly #hello: Promise<Hello> = new Promise<Hello>((resolve, reject) => {
    this.#settleHello = { resolve, reject };
  });
  #helloSeen = false;
  #version = "";
  #capabilities: readonly string[] = [];
  #socketError: Error | undefined;
  #closed = false;

  private constructor(socket: Socket, requestTimeoutMs: number) {
    this.#socket = socket;
    this.#requestTimeoutMs = requestTimeoutMs;
    const reader = new Utf8LineReader((line) => this.#onLine(line));
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      this.#socketError = error;
      // Reported here as well as on `close` so a refused connection fails the handshake
      // with the code that says why, which `close` alone does not carry.
      this.#failHandshake(connectFailure(error));
    });
    socket.on("close", () => this.#shutdown(this.#socketError));
  }

  get appVersion(): string {
    return this.#version;
  }

  get capabilities(): readonly string[] {
    return this.#capabilities;
  }

  /**
   * Sends one request and resolves with the app's `result`.
   *
   * `signal` aborts the caller's wait. For `http.fetch` it also sends `http.abort`, since
   * the app is otherwise left streaming a response body nobody is reading; no other method
   * has anything to cancel. Aborting after the response has arrived is the caller's to
   * handle — by then this request is settled and the signal is no longer watched.
   */
  request<T = unknown>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.startRequest<T>(method, params, signal).result;
  }

  /**
   * Sends one request and hands back its wire id alongside the pending result.
   *
   * `http.fetch` carries its response body in `http.body` events tagged with this id, and
   * those events can arrive in the same socket read as the response line — the reader
   * delivers both synchronously, before anything awaiting the result resumes. A caller
   * that waited for the result to learn the id would have already missed the first chunk,
   * so the id has to be available at send time.
   */
  startRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Readonly<{ id: string; result: Promise<T> }> {
    const id = randomUUID();
    if (this.#closed) {
      return { id, result: Promise.reject(codedError("closed", "The connection to the Shorthand app is closed.")) };
    }
    if (signal?.aborted === true) return { id, result: Promise.reject(abortError(signal)) };

    const result = new Promise<T>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      if (signal !== undefined) {
        const onAbort = (): void => this.#abort(id, method, signal);
        signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", onAbort));
      }
      if (this.#requestTimeoutMs > 0) {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          for (const cleanup of cleanups) cleanup();
          reject(codedError("timeout", `The Shorthand app did not answer ${method} within ${this.#requestTimeoutMs}ms.`));
        }, this.#requestTimeoutMs);
        // A pending request must not be the reason a CLI process stays alive.
        timer.unref?.();
        cleanups.push(() => clearTimeout(timer));
      }
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        dispose: () => {
          for (const cleanup of cleanups) cleanup();
        },
      });
      this.#write({ id, method, params });
    });
    return { id, result };
  }

  onEvent(listener: (event: AppEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  close(): void {
    this.#shutdown(undefined);
    this.#socket.destroy();
  }

  async setCredential(slot: AppCredentialSlot, secret: string): Promise<void> {
    await this.request("credential.set", { slot, secret });
  }

  async clearCredential(slot: AppCredentialSlot): Promise<void> {
    await this.request("credential.clear", { slot });
  }

  /**
   * Matches each reply entry to the slot it answers by structural equality (kind plus
   * provider/vaultId and origin), not array position: the wire contract echoes the slot in
   * every entry and never states that reply order mirrors request order. A requested slot
   * with anything other than exactly one matching entry, or a status this build does not
   * know, makes the whole reply malformed rather than guessed at.
   */
  async credentialStatus(slots: readonly AppCredentialSlot[]): Promise<readonly AppCredentialStatus[]> {
    const result = await this.request<{ statuses?: unknown }>("credential.status", { slots });
    const statuses = result?.statuses;
    if (!Array.isArray(statuses)) {
      throw codedError("malformed", "The Shorthand app answered credential.status with something other than a status list.");
    }
    const entriesByKey = new Map<string, unknown[]>();
    for (const entry of statuses) {
      const key = wireSlotKey((entry as { slot?: unknown } | undefined)?.slot);
      if (key === undefined) continue;
      const bucket = entriesByKey.get(key);
      if (bucket === undefined) entriesByKey.set(key, [entry]);
      else bucket.push(entry);
    }
    return slots.map((slot) => {
      const matches = entriesByKey.get(slotKey(slot)) ?? [];
      if (matches.length !== 1) {
        throw codedError(
          "malformed",
          `The Shorthand app answered credential.status with ${matches.length} entries for a requested slot, expected exactly one.`,
        );
      }
      const status = (matches[0] as { status?: unknown }).status;
      if (status !== "configured" && status !== "missing" && status !== "unavailable") {
        throw codedError("malformed", "The Shorthand app reported a credential status this build does not know.");
      }
      return status;
    });
  }

  async #completeHandshake(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AppUnavailableError(
              "not-running",
              // A socket that accepts and then says nothing is a half-started or wedged
              // app; from here it is as unusable as one that is not running at all.
              `Shorthand accepted the connection but sent no hello line within ${timeoutMs}ms.`,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      const hello = await Promise.race([this.#hello, expiry]);
      this.#version = hello.version;
      this.#capabilities = hello.capabilities;
    } finally {
      clearTimeout(timer);
    }
  }

  #onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // One unparseable line does not invalidate the rest of the stream, and there is no
      // logger here that would not risk printing a secret.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;

    if (!this.#helloSeen) {
      this.#helloSeen = true;
      this.#acceptHello(record);
      return;
    }
    const id = record.id;
    if (isString(id)) {
      this.#settleRequest(id, record);
      return;
    }
    const event = parseEvent(record);
    if (event === undefined) return;
    // A copy: a listener that unsubscribes itself must not disturb this delivery.
    for (const listener of [...this.#eventListeners]) listener(event);
  }

  #acceptHello(record: Record<string, unknown>): void {
    const settle = this.#settleHello;
    this.#settleHello = undefined;
    if (settle === undefined) return;

    const { t, protocol, version, capabilities } = record;
    if (t !== "hello" || typeof protocol !== "number" || !isString(version)) {
      settle.reject(
        new AppUnavailableError("not-running", "Shorthand answered the request socket with something other than a hello line."),
      );
      return;
    }
    if (protocol < APP_PROTOCOL_VERSION) {
      settle.reject(
        new AppUnavailableError(
          "too-old",
          `Shorthand ${version} speaks request-socket protocol ${protocol}; this build needs protocol ${APP_PROTOCOL_VERSION}.`,
          version,
        ),
      );
      return;
    }
    if (protocol > APP_PROTOCOL_VERSION) {
      settle.reject(
        new AppUnavailableError(
          "protocol",
          `Shorthand ${version} speaks request-socket protocol ${protocol}, newer than the protocol ${APP_PROTOCOL_VERSION} this build understands.`,
          version,
        ),
      );
      return;
    }
    settle.resolve({
      version,
      capabilities: Array.isArray(capabilities) ? capabilities.filter(isString) : [],
    });
  }

  #failHandshake(error: Error): void {
    const settle = this.#settleHello;
    this.#settleHello = undefined;
    settle?.reject(error);
  }

  #settleRequest(id: string, record: Record<string, unknown>): void {
    const pending = this.#pending.get(id);
    // No entry means the request was aborted or timed out already; the late answer is
    // expected, not an error.
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.dispose();
    if (record.ok === true) {
      pending.resolve(record.result);
      return;
    }
    const error = (record.error ?? {}) as { code?: unknown; message?: unknown };
    pending.reject(wireError(error.code, error.message));
  }

  #abort(id: string, method: string, signal: AbortSignal): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.dispose();
    if (method === "http.fetch") {
      // Fire and forget: the abort's own response is dropped by `#settleRequest`, and
      // there is nothing a caller could do with it that aborting has not already done.
      this.#write({ id: randomUUID(), method: "http.abort", params: { request: id } });
    }
    pending.reject(abortError(signal));
  }

  #write(message: Record<string, unknown>): void {
    if (this.#closed) return;
    this.#socket.write(`${JSON.stringify(message)}\n`);
  }

  #shutdown(error: Error | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#settleHello !== undefined) {
      this.#failHandshake(
        error ?? new AppUnavailableError("not-running", "Shorthand closed the request socket before completing the handshake."),
      );
    }
    const failure = error ?? codedError("closed", "The connection to the Shorthand app closed.");
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.dispose();
      pending.reject(failure);
    }
    for (const listener of [...this.#closeListeners]) listener(error);
  }
}

function connectFailure(error: NodeJS.ErrnoException): Error {
  // ENOENT is a discovery file naming a socket the app already removed; ECONNREFUSED is a
  // stale Unix socket file left behind by a crash; EACCES/EPERM is a stale pipe or socket
  // file with a DACL or owner that no longer matches this caller. Every errno here, known or
  // not, means the same thing to a caller: the app cannot be reached this way. Mapping only
  // the two known codes let the rest escape raw, so `instanceof AppUnavailableError` missed
  // them and the user saw a bare errno next to the pipe path instead of an actionable message.
  return new AppUnavailableError(
    "not-running",
    `Shorthand is not listening on its request socket (${error.code ?? error.message}).`,
  );
}
