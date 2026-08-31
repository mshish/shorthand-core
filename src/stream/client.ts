import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { Utf8LineReader } from "../ndjson.js";

export const SUPPORTED_PROTOCOL = 1;
export const NOT_RUNNING_MESSAGE =
  "Shorthand is not running, or live transcript streaming is disabled in Advanced settings";

type Speaker = "me" | "them";
type Stamp = { emitted_at?: string; session_elapsed_ms?: number; unstamped?: true };

/**
 * `refused.reason` values this build's `refused` records are documented to carry
 * today. Exported so a consumer can compare against a known value without
 * hardcoding the strings, but deliberately *not* the type of `refused.reason`
 * itself — see that field's own comment on `WireEvent` for why an unrecognized
 * reason must still parse rather than being coerced to one of these or dropped.
 */
export const KNOWN_REFUSAL_REASONS = ["busy", "mode-disabled", "publication-disabled"] as const;

export type KnownRefusalReason = (typeof KNOWN_REFUSAL_REASONS)[number];

export type WireEvent =
  | { t: "hello"; protocol: number; version?: string; emitted_at?: string; capabilities?: string[] }
  | ({ t: "begin"; session: number; streaming: boolean; mode?: BeginMode } & Stamp)
  | ({ t: "partial"; session: number; speaker: Speaker; committed: string; tentative: string } & Stamp)
  | ({ t: "final"; session: number; speaker?: Speaker; text: string } & Stamp)
  | ({ t: "no_speech" | "cancel"; session: number } & Stamp)
  | ({ t: "error"; session: number; message: string } & Stamp)
  // Session-less, like `hello`: no `session`, no `session_elapsed_ms`, so these three
  // take `emitted_at` directly rather than through `Stamp` (whose `unstamped` flag
  // means "this session event was missing its elapsed time", which does not apply to
  // an event that was never going to have one). See parseWireRecord's handling of all
  // three, next to the session-less `error` case, for the full reasoning.
  | { t: "idle"; emitted_at?: string }
  | {
      t: "refused";
      mode?: BeginMode;
      // Deliberately `string`, not a closed union of the reasons above: FOLLOW_STREAM.md
      // is explicit that a follower must treat a `reason` it does not recognize as "refused,
      // but I do not know why" rather than fail to parse the record. `mode` (just below)
      // makes the opposite choice for the opposite reason — see `beginModeField`'s doc
      // comment: an unrecognized *mode* is coerced to `undefined` because a consumer gates
      // real behaviour on it (e.g. whether to attach a capture to a note), and a mode this
      // build does not know must never be mistaken for one it does. `reason` gates nothing;
      // it is shown to a human or logged, so passing the raw string through preserves
      // information (a future reason value is still visible) instead of discarding it the
      // way collapsing to `undefined` would.
      reason: string;
      emitted_at?: string;
    }
  | { t: "start_failed"; mode?: BeginMode; message: string; emitted_at?: string };

export type ConnectionErrorRecord = {
  t: "error";
  code: string;
  message: string;
  emitted_at?: string;
};

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly expected?: number,
    readonly actual?: number,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: Record<string, unknown>, name: string): number | undefined {
  const field = value[name];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}

function stringField(value: Record<string, unknown>, name: string): string | undefined {
  return typeof value[name] === "string" ? value[name] : undefined;
}

/**
 * A missing `capabilities` field is a valid, common case — every protocol-1 app
 * that predates capability negotiation omits it, and that must parse as "no
 * advertised optional capability", not as malformed input. A present-but-wrong-shaped
 * field (not an array, or an array with a non-string member) is dropped rather than
 * trusted or coerced: a consumer that gates a control signal on a capability string
 * must never see a value it did not really advertise.
 */
function stringArrayField(value: Record<string, unknown>, name: string): string[] | undefined {
  const field = value[name];
  if (!Array.isArray(field) || !field.every((item): item is string => typeof item === "string")) return undefined;
  return field;
}

/**
 * Every capture mode `shorthand-app` names on a `begin` record. The spellings are
 * the wire contract and must match its `FollowMode` serialization exactly.
 */
export const BEGIN_MODES = ["meeting", "assisted-notes", "dictation"] as const;

export type BeginMode = (typeof BEGIN_MODES)[number];

/**
 * Absent and unrecognized are the same answer — `undefined` — and deliberately so.
 *
 * Absent is the common, permanent case: every app that predates the field omits it.
 * Unrecognized is dropped for the reason `stringArrayField` gives above: a consumer
 * gates behaviour on this, and the plugin's gate decides whether to start writing
 * into someone's note. A mode invented by a newer app must read as "not one of the
 * modes I know", never as one of them.
 *
 * Nothing on `hello` lets a follower tell those two cases apart today: "this app
 * predates the field" and "this app sent a mode this build does not recognize" both
 * arrive here as the same `undefined`. A follower that needs the distinction must
 * treat `undefined` as "not my business" rather than infer a default from it — a
 * `begin-mode` capability on `hello` would resolve the ambiguity if `shorthand-app`
 * ever emits one, but as of this writing it does not.
 */
function beginModeField(value: Record<string, unknown>): BeginMode | undefined {
  const field = value.mode;
  return (BEGIN_MODES as readonly unknown[]).includes(field) ? (field as BeginMode) : undefined;
}

function stamp(value: Record<string, unknown>): Stamp {
  const emittedAt = stringField(value, "emitted_at");
  const elapsed = numberField(value, "session_elapsed_ms");
  return {
    ...(emittedAt === undefined ? {} : { emitted_at: emittedAt }),
    ...(elapsed === undefined ? { unstamped: true as const } : { session_elapsed_ms: elapsed }),
  };
}

export function parseWireRecord(input: unknown): WireEvent | ConnectionErrorRecord | null {
  if (!isRecord(input) || typeof input.t !== "string") return null;

  if (input.t === "hello") {
    const protocol = numberField(input, "protocol");
    if (protocol === undefined) throw new ProtocolError("hello record is missing a numeric protocol");
    if (protocol !== SUPPORTED_PROTOCOL) {
      throw new ProtocolError(
        `Unsupported Shorthand follow-stream protocol: expected ${SUPPORTED_PROTOCOL}, received ${protocol}. Update Shorthand or use a compatible Shorthand build.`,
        SUPPORTED_PROTOCOL,
        protocol,
      );
    }
    const version = stringField(input, "version");
    const emittedAt = stringField(input, "emitted_at");
    const capabilities = stringArrayField(input, "capabilities");
    return {
      t: "hello",
      protocol,
      ...(version === undefined ? {} : { version }),
      ...(emittedAt === undefined ? {} : { emitted_at: emittedAt }),
      ...(capabilities === undefined ? {} : { capabilities }),
    };
  }

  if (input.t === "error" && input.session === undefined) {
    const code = stringField(input, "code");
    if (code === undefined) return null;
    const message = stringField(input, "message") ?? code;
    const emittedAt = stringField(input, "emitted_at");
    return { t: "error", code, message, ...(emittedAt === undefined ? {} : { emitted_at: emittedAt }) };
  }

  // `idle`, `refused` and `start_failed` are the three session-less records FOLLOW_STREAM.md
  // added alongside the explicit start/stop commands. Before this, every branch below the
  // session-less `error` case fell through to `numberField(input, "session")`, which returns
  // `undefined` for all three (none of them ever carries a `session`) and silently dropped the
  // record. That made a refusal, a failed start, and the idle state themselves unobservable —
  // not merely mis-parsed but invisible — so they must be handled here, before that
  // requirement, exactly like the session-less `error` case just above.
  if (input.t === "idle") {
    const emittedAt = stringField(input, "emitted_at");
    return { t: "idle", ...(emittedAt === undefined ? {} : { emitted_at: emittedAt }) };
  }

  if (input.t === "refused") {
    // `reason` is required: a `refused` record with no `reason` at all (as opposed to one
    // whose `reason` this build does not recognize) is malformed, not merely unexplained.
    const reason = stringField(input, "reason");
    if (reason === undefined) return null;
    // `mode` reuses `beginModeField` rather than a bespoke parse: the same failure it guards
    // on `begin` applies here — a mode this build does not recognize must read as `undefined`
    // ("not one of the modes I know"), not be passed through, because a consumer gates
    // real behaviour on which mode a `refused`/`start_failed` record is about.
    const mode = beginModeField(input);
    const emittedAt = stringField(input, "emitted_at");
    return {
      t: "refused",
      reason,
      ...(mode === undefined ? {} : { mode }),
      ...(emittedAt === undefined ? {} : { emitted_at: emittedAt }),
    };
  }

  if (input.t === "start_failed") {
    const message = stringField(input, "message");
    if (message === undefined) return null;
    // Same reuse of `beginModeField`, same reason, as `refused` above.
    const mode = beginModeField(input);
    const emittedAt = stringField(input, "emitted_at");
    return {
      t: "start_failed",
      message,
      ...(mode === undefined ? {} : { mode }),
      ...(emittedAt === undefined ? {} : { emitted_at: emittedAt }),
    };
  }

  const session = numberField(input, "session");
  if (session === undefined) return null;
  const eventStamp = stamp(input);

  switch (input.t) {
    case "begin": {
      if (typeof input.streaming !== "boolean") return null;
      const mode = beginModeField(input);
      // Conditional spread, matching every other optional field in this parser:
      // `exactOptionalPropertyTypes` forbids assigning an explicit `undefined` to
      // an optional property.
      return { t: "begin", session, streaming: input.streaming, ...(mode === undefined ? {} : { mode }), ...eventStamp };
    }
    case "partial": {
      const speaker = input.speaker;
      const committed = stringField(input, "committed");
      const tentative = stringField(input, "tentative");
      if ((speaker !== "me" && speaker !== "them") || committed === undefined || tentative === undefined) return null;
      return { t: "partial", session, speaker, committed, tentative, ...eventStamp };
    }
    case "final": {
      const text = stringField(input, "text");
      const speaker = input.speaker;
      if (text === undefined || (speaker !== undefined && speaker !== "me" && speaker !== "them")) return null;
      return { t: "final", session, ...(speaker === undefined ? {} : { speaker }), text, ...eventStamp };
    }
    case "no_speech":
    case "cancel":
      return { t: input.t, session, ...eventStamp };
    case "error": {
      const message = stringField(input, "message");
      if (message === undefined) return null;
      return { t: "error", session, message, ...eventStamp };
    }
    default:
      return null;
  }
}

export class NdjsonDecoder {
  // Byte-and-line framing (the multi-byte-safe chunk buffering) lives in Utf8LineReader, shared
  // with agent/codex-app-server.ts's JSON-RPC reader — see that module's doc comment for why the
  // two must not diverge. This class owns only what is specific to the transcript wire protocol:
  // turning a line into a WireEvent via parseWireRecord.
  readonly #reader: Utf8LineReader;

  constructor(
    private readonly onRecord: (record: WireEvent | ConnectionErrorRecord) => void,
    private readonly onError: (error: Error, line: string) => void = () => {},
  ) {
    this.#reader = new Utf8LineReader((line) => this.#parse(line));
  }

  push(chunk: Buffer): void {
    this.#reader.push(chunk);
  }

  end(chunk?: Buffer): void {
    this.#reader.end(chunk);
  }

  #parse(line: string): void {
    try {
      const record = parseWireRecord(JSON.parse(line));
      if (record !== null) this.onRecord(record);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)), line);
    }
  }
}

export type ExitDiagnosis = {
  code: number | null;
  clean: boolean;
  message: string;
};

export function diagnoseExit(code: number | null, stderr: string): ExitDiagnosis {
  if (code === 2) return { code, clean: false, message: NOT_RUNNING_MESSAGE };
  if (code === 1) return { code, clean: false, message: stderr };
  if (code === 0) {
    return {
      code,
      clean: true,
      message: "follow-stream closed cleanly; exit 0 does not prove that an active session completed",
    };
  }
  return { code, clean: false, message: stderr || `follow-stream exited with code ${String(code)}` };
}

export type SpawnFn = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

export type StreamClientOptions = {
  command: string;
  args?: readonly string[];
  maxReconnectAttempts?: number;
  backoffMs?: readonly number[];
  reconnectOnExit?: boolean;
  stableConnectionMs?: number;
  drainTimeoutMs?: number;
  spawnFn?: SpawnFn;
};

export class StreamClient extends EventEmitter {
  #child: ChildProcess | null = null;
  #active = false;
  #attempts = 0;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  #drainTimer: ReturnType<typeof setTimeout> | null = null;
  #stderr = "";
  #activeSessions = new Set<number>();
  #drainRequested = false;
  #receivedHelloEver = false;
  #sawSessionEvent = false;
  #protocolFailed = false;
  #settled = false;

  constructor(private readonly options: StreamClientOptions) {
    super();
  }

  get connectionGeneration(): number { return this.#generation; }
  get active(): boolean { return this.#active; }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#settled = false;
    this.#spawn();
  }

  stopAfterDrain(): void {
    this.#drainRequested = true;
    this.#active = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#child === null) {
      this.#emitSettled(diagnoseExit(null, "capture stopped during reconnect backoff"));
      return;
    }
    if (this.#activeSessions.size === 0) {
      this.#killChild();
      return;
    }
    const timeoutMs = this.options.drainTimeoutMs ?? 10_000;
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = null;
      this.emit("drainTimeout", { timeoutMs, activeSessions: [...this.#activeSessions] });
      this.forceStop();
    }, timeoutMs);
  }

  forceStop(): void {
    this.#active = false;
    this.#drainRequested = false;
    this.#clearTimers();
    if (this.#child === null) {
      this.#emitSettled(diagnoseExit(null, "capture force-stopped"));
      return;
    }
    this.#killChild();
  }

  #clearTimers(): void {
    for (const timer of [this.#timer, this.#stabilityTimer, this.#drainTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.#timer = null;
    this.#stabilityTimer = null;
    this.#drainTimer = null;
  }

  #killChild(): void {
    if (this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill();
    }
  }

  #spawn(): void {
    this.#stderr = "";
    this.#sawSessionEvent = false;
    this.#protocolFailed = false;
    const spawnFn = this.options.spawnFn ?? spawn;
    const child = spawnFn(this.options.command, [...(this.options.args ?? [])], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    });
    if (child.stdout === null || child.stderr === null) {
      throw new Error("follow-stream child must expose piped stdout and stderr");
    }
    this.#child = child;
    const decoder = new NdjsonDecoder(
      (record) => this.#onRecord(record),
      (error, line) => {
        if (error instanceof ProtocolError && error.actual !== undefined) {
          this.#protocolFailed = true;
          this.#active = false;
          this.emit("protocolError", { error, line, generation: this.#generation });
          this.#killChild();
        } else {
          this.emit("parseError", { error, line, generation: this.#generation });
        }
      },
    );
    child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { this.#stderr += chunk.toString("utf8"); });
    child.on("error", (error: Error) => {
      const processError = error as NodeJS.ErrnoException;
      const fatal = processError.code === "ENOENT";
      if (fatal) this.#active = false;
      this.emit("processError", { error: processError, command: this.options.command, fatal });
    });
    child.on("close", (code) => {
      decoder.end();
      this.#child = null;
      if (this.#stabilityTimer !== null) clearTimeout(this.#stabilityTimer);
      this.#stabilityTimer = null;
      const diagnosis = diagnoseExit(code, this.#stderr);
      const hadSessionEvents = this.#sawSessionEvent;
      this.emit("disconnect", { generation: this.#generation, diagnosis, hadSessionEvents });
      this.#activeSessions.clear();

      if (!this.#active || this.options.reconnectOnExit === false || this.#protocolFailed) {
        this.#emitSettled(diagnosis);
        return;
      }
      if (code === 2 && !this.#receivedHelloEver) {
        this.#active = false;
        this.#emitSettled(diagnosis);
        return;
      }

      const maximum = this.options.maxReconnectAttempts ?? 4;
      if (this.#attempts >= maximum) {
        this.#active = false;
        this.emit("giveUp", { attempts: this.#attempts, diagnosis });
        this.#emitSettled(diagnosis);
        return;
      }

      this.#attempts += 1;
      this.#generation += 1;
      const backoffs = this.options.backoffMs ?? [250, 500, 1_000, 2_000];
      const delayMs = backoffs[Math.min(this.#attempts - 1, backoffs.length - 1)] ?? 0;
      this.emit("reconnect", {
        attempt: this.#attempts,
        generation: this.#generation,
        delayMs,
        diagnosis,
        gap: hadSessionEvents,
      });
      this.#timer = setTimeout(() => {
        this.#timer = null;
        if (this.#active) this.#spawn();
      }, delayMs);
    });
  }

  #onRecord(record: WireEvent | ConnectionErrorRecord): void {
    if (this.#protocolFailed) return;
    if (record.t === "error" && !("session" in record)) {
      this.emit("connectionError", { generation: this.#generation, record });
      return;
    }
    if (record.t === "hello") {
      this.#receivedHelloEver = true;
      if (this.#stabilityTimer !== null) clearTimeout(this.#stabilityTimer);
      this.#stabilityTimer = setTimeout(() => {
        this.#stabilityTimer = null;
        this.#attempts = 0;
      }, this.options.stableConnectionMs ?? 30_000);
    } else if (record.t !== "idle" && record.t !== "refused" && record.t !== "start_failed") {
      // `#sawSessionEvent` feeds `hadSessionEvents` on `disconnect`, and `reconnect`'s
      // `gap` field: both exist to tell a caller whether this connection actually carried
      // transcript activity before it died, so it can decide whether a reconnect is a
      // silent retry or a real gap in coverage. `idle`/`refused`/`start_failed` are
      // connection-state and control-response records, not transcript activity — none of
      // them belongs to a session, per parseWireRecord's comment above — so counting one
      // would tell a caller a session happened when at most a refusal or an idle
      // connection was observed.
      this.#sawSessionEvent = true;
    }
    if (record.t === "begin") {
      this.#activeSessions.add(record.session);
      this.#attempts = 0;
    }
    if (record.t === "final" || record.t === "no_speech" || record.t === "cancel" || record.t === "error") {
      this.#activeSessions.delete(record.session);
    }
    this.emit("event", { generation: this.#generation, record });
    // `idle`/`refused`/`start_failed` never reach the `begin`/terminal-event branches above,
    // so they never add to or remove from `#activeSessions`; a drain requested while a real
    // session is still open cannot be short-circuited by one of them arriving in between.
    if (this.#drainRequested && this.#activeSessions.size === 0) {
      if (this.#drainTimer !== null) clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
      this.#killChild();
    }
  }

  #emitSettled(diagnosis: ExitDiagnosis): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearTimers();
    this.emit("settled", diagnosis);
  }
}
