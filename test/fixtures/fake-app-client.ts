import type { AppClientLike, AppCredentialSlot, AppCredentialStatus, AppEvent } from "../../src/app/client.js";

export type SentRequest = Readonly<{ id: string; method: string; params: Record<string, unknown> }>;

/**
 * A scripted stand-in for `ShorthandAppClient`, so the `fetch` and `WebSocket` shims can be
 * driven through orderings a real app would be hard to provoke — a body chunk delivered in
 * the same turn as the response, an abort mid-stream, a relay that errors without closing.
 *
 * It mirrors the real client where the shims depend on the behaviour: ids are handed out at
 * send time, and aborting an `http.fetch` sends `http.abort` and rejects the caller.
 */
export class FakeAppClient implements AppClientLike {
  readonly appVersion = "0.5.0";
  readonly capabilities: readonly string[] = ["credential", "http-fetch", "ws-relay"];
  readonly sent: SentRequest[] = [];

  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly #eventListeners = new Set<(event: AppEvent) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #nextId = 1;

  get eventListenerCount(): number {
    return this.#eventListeners.size;
  }

  /** The ids of requests the fake has been told to send but has not answered. */
  get pendingIds(): readonly string[] {
    return [...this.#pending.keys()];
  }

  /** The last request sent with `method`, which is what most assertions are about. */
  lastSent(method: string): SentRequest | undefined {
    return [...this.sent].reverse().find((request) => request.method === method);
  }

  startRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Readonly<{ id: string; result: Promise<T> }> {
    const id = `r${this.#nextId++}`;
    this.sent.push({ id, method, params });
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      if (signal === undefined) return;
      if (signal.aborted) {
        this.#abort(id, method, signal);
        return;
      }
      signal.addEventListener("abort", () => this.#abort(id, method, signal), { once: true });
    });
    return { id, result };
  }

  request<T = unknown>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.startRequest<T>(method, params, signal).result;
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
    for (const listener of [...this.#closeListeners]) listener();
  }

  setCredential(_slot: AppCredentialSlot, _secret: string): Promise<void> {
    throw new Error("The transport shims do not touch credentials.");
  }

  clearCredential(_slot: AppCredentialSlot): Promise<void> {
    throw new Error("The transport shims do not touch credentials.");
  }

  credentialStatus(_slots: readonly AppCredentialSlot[]): Promise<readonly AppCredentialStatus[]> {
    throw new Error("The transport shims do not touch credentials.");
  }

  /** Answers a request with `ok: true`. */
  respond(id: string, result: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new Error(`No pending request ${id}.`);
    this.#pending.delete(id);
    pending.resolve(result);
  }

  /** Answers a request with `ok: false`, carrying the wire `code` the real client attaches. */
  fail(id: string, code: string, message: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new Error(`No pending request ${id}.`);
    this.#pending.delete(id);
    pending.reject(Object.assign(new Error(message), { code }));
  }

  /** Delivers an id-less event, synchronously, exactly as the real client's reader does. */
  emit(event: AppEvent): void {
    for (const listener of [...this.#eventListeners]) listener(event);
  }

  #abort(id: string, method: string, signal: AbortSignal): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    // The real client sends `http.abort` itself, but only while the request is still
    // pending; the shim owns the window after the response line.
    if (method === "http.fetch") this.sent.push({ id: `a${this.#nextId++}`, method: "http.abort", params: { request: id } });
    pending.reject(signal.reason instanceof Error ? signal.reason : new Error("The request was aborted."));
  }
}
