import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  NdjsonDecoder,
  NOT_RUNNING_MESSAGE,
  ProtocolError,
  StreamClient,
  diagnoseExit,
  parseWireRecord,
} from "../src/stream/client.js";

const hello = '{"t":"hello","protocol":1,"version":"0.9.5"}';

describe("NDJSON framing", () => {
  test("decodes a multibyte UTF-8 character split across chunks", () => {
    const records: unknown[] = [];
    const decoder = new NdjsonDecoder((record) => records.push(record));
    const line = Buffer.from('{"t":"error","code":"future","message":"café"}\n');
    const split = line.indexOf(Buffer.from("é")) + 1;
    decoder.push(line.subarray(0, split));
    decoder.push(line.subarray(split));
    decoder.end();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ message: "café" });
  });

  test("parses several NDJSON lines in one chunk", () => {
    const records: unknown[] = [];
    const decoder = new NdjsonDecoder((record) => records.push(record));
    decoder.push(Buffer.from(`${hello}\n${hello}\n${hello}\n`));
    decoder.end();
    expect(records).toHaveLength(3);
  });

  test("reassembles a line split across chunks", () => {
    const records: unknown[] = [];
    const decoder = new NdjsonDecoder((record) => records.push(record));
    decoder.push(Buffer.from(hello.slice(0, 17)));
    expect(records).toHaveLength(0);
    decoder.push(Buffer.from(`${hello.slice(17)}\n`));
    expect(records).toHaveLength(1);
  });

  test("parses an unterminated tail at process exit", () => {
    const records: unknown[] = [];
    const decoder = new NdjsonDecoder((record) => records.push(record));
    decoder.push(Buffer.from(hello));
    decoder.end();
    expect(records).toHaveLength(1);
  });
});

describe("wire compatibility", () => {
  test("ignores unknown fields and unknown event types", () => {
    expect(parseWireRecord({ t: "future", protocol: 99 })).toBeNull();
    expect(parseWireRecord({ t: "hello", protocol: 1, future: { anything: true } })).toEqual({
      t: "hello",
      protocol: 1,
    });
  });

  test("validates hello.protocol", () => {
    expect(() => parseWireRecord({ t: "hello", protocol: 2 })).toThrow(ProtocolError);
    expect(() => parseWireRecord({ t: "hello" })).toThrow("numeric protocol");
  });

  test("preserves advertised hello capabilities", () => {
    expect(parseWireRecord({ t: "hello", protocol: 1, capabilities: ["toggle-assisted-notes"] })).toEqual({
      t: "hello",
      protocol: 1,
      capabilities: ["toggle-assisted-notes"],
    });
  });

  test("a hello with no capabilities still parses, for apps that predate capability negotiation", () => {
    expect(parseWireRecord({ t: "hello", protocol: 1 })).toEqual({ t: "hello", protocol: 1 });
  });

  test("a malformed capabilities value is dropped, not treated as support", () => {
    expect(parseWireRecord({ t: "hello", protocol: 1, capabilities: "toggle-assisted-notes" })).toEqual({
      t: "hello",
      protocol: 1,
    });
    expect(parseWireRecord({ t: "hello", protocol: 1, capabilities: ["toggle-assisted-notes", 7] })).toEqual({
      t: "hello",
      protocol: 1,
    });
  });

  test("surfaces connection-level error records distinctly", () => {
    expect(parseWireRecord({
      t: "error",
      code: "follower_limit",
      message: "too many followers",
      emitted_at: "2026-08-15T14:03:21.000-07:00",
    })).toEqual({
      t: "error",
      code: "follower_limit",
      message: "too many followers",
      emitted_at: "2026-08-15T14:03:21.000-07:00",
    });
  });

  test("surfaces a code-only follower_limit connection error", () => {
    expect(parseWireRecord({ t: "error", code: "follower_limit" })).toEqual({
      t: "error",
      code: "follower_limit",
      message: "follower_limit",
    });
  });

  test("accepts session events without session_elapsed_ms and marks them unstamped", () => {
    expect(parseWireRecord({
      t: "partial",
      session: 1,
      speaker: "me",
      committed: "legacy",
      tentative: "",
    })).toMatchObject({ t: "partial", committed: "legacy", unstamped: true });
  });

  test("reads a begin record's capture mode", () => {
    expect(parseWireRecord({ t: "begin", session: 1, streaming: true, mode: "assisted-notes" })).toEqual({
      t: "begin",
      session: 1,
      streaming: true,
      mode: "assisted-notes",
      unstamped: true,
    });
  });

  test("accepts a begin record with no mode, because every app before the field omits it", () => {
    expect(parseWireRecord({ t: "begin", session: 1, streaming: true })).toEqual({
      t: "begin",
      session: 1,
      streaming: true,
      unstamped: true,
    });
  });

  // Dropped rather than passed through: the plugin decides whether to attach a
  // capture to a user's note from this value, so it must never see one the app
  // did not really send. Same rule as `capabilities`.
  test("drops a mode it does not recognize instead of passing it through", () => {
    expect(parseWireRecord({ t: "begin", session: 1, streaming: true, mode: "karaoke" })).toEqual({
      t: "begin",
      session: 1,
      streaming: true,
      unstamped: true,
    });
    expect(parseWireRecord({ t: "begin", session: 1, streaming: true, mode: 7 })).toEqual({
      t: "begin",
      session: 1,
      streaming: true,
      unstamped: true,
    });
  });

  test("keeps rejecting a begin record with no streaming flag", () => {
    expect(parseWireRecord({ t: "begin", session: 1, mode: "meeting" })).toBeNull();
  });

  test("preserves the new capabilities a hello can advertise", () => {
    const capabilities = [
      "toggle-assisted-notes",
      "start-assisted-notes",
      "stop-assisted-notes",
      "begin-mode",
      "capture-state",
      "refused",
      "refused-publication-disabled",
      "start-failed",
      "start-failed-code",
    ];
    expect(parseWireRecord({ t: "hello", protocol: 1, capabilities })).toEqual({
      t: "hello",
      protocol: 1,
      capabilities,
    });
  });

  test("parses capture_state while idle, with all optional fields absent", () => {
    expect(parseWireRecord({ t: "capture_state", phase: "idle", emitted_at: "2026-08-15T14:03:20.100-07:00" })).toEqual({
      t: "capture_state",
      phase: "idle",
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    });
  });

  test("capture_state with no emitted_at still parses", () => {
    expect(parseWireRecord({ t: "capture_state", phase: "idle" })).toEqual({ t: "capture_state", phase: "idle" });
  });

  test("parses capture_state while recording, not publishing, with mode and no session", () => {
    expect(parseWireRecord({
      t: "capture_state",
      phase: "recording",
      mode: "dictation",
      publishing: false,
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    })).toEqual({
      t: "capture_state",
      phase: "recording",
      mode: "dictation",
      publishing: false,
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    });
  });

  test("parses capture_state while processing and publishing, with session", () => {
    expect(parseWireRecord({
      t: "capture_state",
      phase: "processing",
      mode: "meeting",
      publishing: true,
      session: 42,
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    })).toEqual({
      t: "capture_state",
      phase: "processing",
      mode: "meeting",
      publishing: true,
      session: 42,
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    });
  });

  // `publishing: false` and `publishing` absent are different states — a real, deliberately
  // silent capture versus nothing capturing at all — so a parse that collapsed one into the
  // other would erase that distinction. The idle case above already covers `publishing`
  // absent; this asserts the two are not merely equal-looking but distinguishable via `in`.
  test("publishing:false is distinguishable from publishing absent", () => {
    const notPublishing = parseWireRecord({ t: "capture_state", phase: "recording", mode: "dictation", publishing: false });
    const idle = parseWireRecord({ t: "capture_state", phase: "idle" });
    expect(notPublishing).not.toBeNull();
    expect(idle).not.toBeNull();
    expect(notPublishing && "publishing" in notPublishing).toBe(true);
    expect((notPublishing as { publishing?: boolean }).publishing).toBe(false);
    expect(idle && "publishing" in idle).toBe(false);
  });

  // `phase` gates real consumer behaviour and is required (see capturePhaseField's doc
  // comment): an unrecognized value has no safe reading, so the whole record is dropped
  // as malformed rather than passed through with a guessed phase.
  test("an unrecognized phase makes the whole capture_state record malformed", () => {
    expect(parseWireRecord({ t: "capture_state", phase: "sleeping" })).toBeNull();
    expect(parseWireRecord({ t: "capture_state" })).toBeNull();
  });

  // Unlike `reason` on `refused`, `mode` reuses beginModeField's undefined-on-unrecognized
  // behaviour: a consumer gates real behaviour on which mode a capture is, so a mode this
  // build does not know must never be mistaken for one it does.
  test("an unrecognized mode on capture_state is dropped to undefined, not passed through", () => {
    expect(parseWireRecord({ t: "capture_state", phase: "recording", mode: "karaoke", publishing: true })).toEqual({
      t: "capture_state",
      phase: "recording",
      publishing: true,
    });
  });

  test("parses a refused record with a known reason and mode", () => {
    expect(parseWireRecord({
      t: "refused",
      mode: "assisted-notes",
      reason: "busy",
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    })).toEqual({
      t: "refused",
      mode: "assisted-notes",
      reason: "busy",
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    });
  });

  // FOLLOW_STREAM.md is explicit that an unrecognized reason must still produce a usable
  // record — "refused, but I do not know why" — rather than fail to parse. `reason` is
  // deliberately not a closed union for this: the raw string survives instead of being
  // dropped or coerced to undefined.
  test("an unrecognized reason still parses, carrying the raw string through", () => {
    expect(parseWireRecord({ t: "refused", mode: "assisted-notes", reason: "a-future-reason" })).toEqual({
      t: "refused",
      mode: "assisted-notes",
      reason: "a-future-reason",
    });
  });

  // Unlike `reason`, `mode` reuses beginModeField's undefined-on-unrecognized behaviour:
  // a consumer gates real behaviour on which mode a refusal is about, so a mode this
  // build does not know must never be mistaken for one it does.
  test("an unrecognized mode on refused is dropped to undefined, not passed through", () => {
    expect(parseWireRecord({ t: "refused", mode: "karaoke", reason: "busy" })).toEqual({
      t: "refused",
      reason: "busy",
    });
  });

  test("a refused record with no reason at all is malformed", () => {
    expect(parseWireRecord({ t: "refused", mode: "assisted-notes" })).toBeNull();
  });

  test("parses a start_failed record", () => {
    expect(parseWireRecord({
      t: "start_failed",
      mode: "assisted-notes",
      message: "no input device",
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    })).toEqual({
      t: "start_failed",
      mode: "assisted-notes",
      message: "no input device",
      emitted_at: "2026-08-15T14:03:20.100-07:00",
    });
  });

  test("an unrecognized mode on start_failed is dropped to undefined, not passed through", () => {
    expect(parseWireRecord({ t: "start_failed", mode: "karaoke", message: "no input device" })).toEqual({
      t: "start_failed",
      message: "no input device",
    });
  });

  test("a start_failed record with no message at all is malformed", () => {
    expect(parseWireRecord({ t: "start_failed", mode: "assisted-notes" })).toBeNull();
  });

  test("parses a start_failed record's code", () => {
    expect(parseWireRecord({
      t: "start_failed",
      mode: "assisted-notes",
      code: "no-input-device",
      message: "no input device",
    })).toEqual({
      t: "start_failed",
      mode: "assisted-notes",
      code: "no-input-device",
      message: "no input device",
    });
  });

  // Open set, exactly like `refused.reason`: the start path's classifier can grow a new
  // code without a protocol bump, so an unrecognized value must still parse rather than
  // fail, carrying the raw string through instead of being dropped or coerced.
  test("an unrecognized start_failed code still parses, carrying the raw string through", () => {
    expect(parseWireRecord({
      t: "start_failed",
      mode: "assisted-notes",
      code: "a-future-code",
      message: "no input device",
    })).toEqual({
      t: "start_failed",
      mode: "assisted-notes",
      code: "a-future-code",
      message: "no input device",
    });
  });

  // Older builds sent `start_failed` before `code` existed at all — absence is a normal
  // legacy case, not a malformed record, unlike `refused.reason` which has always been
  // mandatory.
  test("a start_failed record with no code at all still parses", () => {
    expect(parseWireRecord({ t: "start_failed", mode: "assisted-notes", message: "no input device" })).toEqual({
      t: "start_failed",
      mode: "assisted-notes",
      message: "no input device",
    });
  });
});

describe("process lifecycle", () => {
  test("maps startup exit codes without treating zero as session completion", () => {
    expect(diagnoseExit(2, "ignored").message).toBe(NOT_RUNNING_MESSAGE);
    expect(diagnoseExit(1, "first line\r\nsecond line\r\n").message).toBe("first line\r\nsecond line\r\n");
    expect(diagnoseExit(0, "")).toMatchObject({ clean: true });
  });

  test("retries with bounded backoff, bumps generation, and surfaces give-up", async () => {
    const client = new StreamClient({
      command: process.execPath,
      args: ["--eval", ""],
      maxReconnectAttempts: 2,
      backoffMs: [0, 0],
    });
    const reconnects: Array<{ attempt: number; generation: number }> = [];
    client.on("reconnect", (event) => reconnects.push(event));
    const gaveUp = new Promise<{ attempts: number }>((resolve) => client.once("giveUp", resolve));
    client.start();
    expect((await gaveUp).attempts).toBe(2);
    expect(reconnects).toEqual([
      expect.objectContaining({ attempt: 1, generation: 1 }),
      expect.objectContaining({ attempt: 2, generation: 2 }),
    ]);
    expect(client.active).toBe(false);
  }, 5_000);

  test("does not reset reconnect attempts for hello-only short-lived connections", async () => {
    let spawnCount = 0;
    const client = new StreamClient({
      command: "fake",
      maxReconnectAttempts: 2,
      backoffMs: [0, 0],
      spawnFn: () => {
        spawnCount += 1;
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.write(`${hello}\n`);
          child.emit("close", 1);
        });
        return child as unknown as ChildProcess;
      },
    });
    const gaveUp = new Promise<{ attempts: number }>((resolve) => client.once("giveUp", resolve));
    client.start();
    expect((await gaveUp).attempts).toBe(2);
    expect(spawnCount).toBe(3);
  });

  test("does not retry exit code 2 before the first successful hello", async () => {
    const child = fakeChild();
    const client = new StreamClient({
      command: "fake",
      backoffMs: [0],
      spawnFn: () => child as unknown as ChildProcess,
    });
    const reconnects: unknown[] = [];
    client.on("reconnect", (event) => reconnects.push(event));
    const settled = new Promise<void>((resolve) => client.once("settled", () => resolve()));
    client.start();
    child.emit("close", 2);
    await settled;
    expect(reconnects).toHaveLength(0);
    expect(client.active).toBe(false);
  });

  test("treats spawn ENOENT as fatal and reports the configured binary path", async () => {
    const child = fakeChild();
    const client = new StreamClient({
      command: "C:/missing/shorthand.exe",
      spawnFn: () => child as unknown as ChildProcess,
    });
    const surfaced = new Promise<{ command: string; fatal: boolean }>((resolve) => client.once("processError", resolve));
    const reconnects: unknown[] = [];
    client.on("reconnect", (event) => reconnects.push(event));
    client.start();
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    child.emit("error", missing);
    expect(await surfaced).toMatchObject({ command: "C:/missing/shorthand.exe", fatal: true });
    child.emit("close", null);
    expect(reconnects).toHaveLength(0);
    expect(client.active).toBe(false);
  });

  test("StreamClient emits connection errors on their own channel", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    const client = new StreamClient({
      command: "fake",
      reconnectOnExit: false,
      spawnFn: () => child as unknown as ChildProcess,
    });
    const surfaced = new Promise<{ record: { t: string; code: string; message: string } }>((resolve) => client.once("connectionError", resolve));
    client.start();
    child.stdout.write('{"t":"error","code":"follower_limit"}\n');
    expect((await surfaced).record).toEqual({
      t: "error",
      code: "follower_limit",
      message: "follower_limit",
    });
    child.emit("close", 0);
  });

  test("StreamClient surfaces hello.protocol:2 separately and stops without reconnecting", async () => {
    const child = fakeChild();
    const client = new StreamClient({
      command: "fake",
      backoffMs: [0],
      spawnFn: () => child as unknown as ChildProcess,
    });
    const protocolFailure = new Promise<{ error: ProtocolError }>((resolve) => client.once("protocolError", resolve));
    const reconnects: unknown[] = [];
    client.on("reconnect", (event) => reconnects.push(event));
    client.start();
    child.stdout.write('{"t":"hello","protocol":2}\n');
    expect((await protocolFailure).error.message).toContain("expected 1, received 2");
    child.emit("close", 1);
    expect(reconnects).toHaveLength(0);
    expect(client.active).toBe(false);
  });

  test("capture_state/refused/start_failed reach the event channel but do not count as session activity", async () => {
    const child = fakeChild();
    const client = new StreamClient({
      command: "fake",
      reconnectOnExit: false,
      spawnFn: () => child as unknown as ChildProcess,
    });
    const events: string[] = [];
    client.on("event", ({ record }) => events.push(record.t));
    const disconnect = new Promise<{ hadSessionEvents: boolean }>((resolve) => client.once("disconnect", resolve));
    client.start();
    child.stdout.write(
      `${hello}\n` +
        '{"t":"capture_state","phase":"idle","emitted_at":"2026-08-15T14:03:20.100-07:00"}\n' +
        '{"t":"refused","mode":"assisted-notes","reason":"busy"}\n' +
        '{"t":"start_failed","mode":"assisted-notes","code":"no-input-device","message":"no input device"}\n',
    );
    child.emit("close", 0);
    // All three still reach a consumer — the bug this change fixes was that
    // parseWireRecord dropped them before they ever got this far.
    expect(events).toEqual(["hello", "capture_state", "refused", "start_failed"]);
    // None of the three is transcript activity, so #sawSessionEvent must stay false: a
    // caller reading `hadSessionEvents` off `disconnect` (or `gap` off `reconnect`) would
    // otherwise be told a session happened when only a refusal/connection-state
    // snapshot/failure was observed.
    expect((await disconnect).hadSessionEvents).toBe(false);
  });

  // `capture_state` can carry its own `session` (identifying the active publication), which
  // is a different field from the one `#activeSessions`/drain tracking cares about — the
  // replayed `begin` is what actually opens a session. A `capture_state` reporting an active
  // session must not, by itself, make the client believe a session is open for drain purposes.
  test("a capture_state reporting an active session still does not count as session activity or open a drain session", async () => {
    let killed = false;
    const child = fakeChild(() => { killed = true; });
    const client = new StreamClient({
      command: "fake",
      reconnectOnExit: false,
      spawnFn: () => child as unknown as ChildProcess,
    });
    const events: string[] = [];
    client.on("event", ({ record }) => events.push(record.t));
    const disconnect = new Promise<{ hadSessionEvents: boolean }>((resolve) => client.once("disconnect", resolve));
    client.start();
    // No `begin` follows this `capture_state` — it reports session 42 itself, but that must
    // not, on its own, register 42 in `#activeSessions`.
    child.stdout.write(
      `${hello}\n` +
        '{"t":"capture_state","phase":"processing","mode":"meeting","publishing":true,"session":42}\n',
    );
    expect(events).toEqual(["hello", "capture_state"]);
    // If `capture_state.session` had opened an active session, `stopAfterDrain` would take
    // the "wait for it to close" branch and not kill immediately. Because it did not,
    // `#activeSessions.size === 0` and the child is killed right away.
    client.stopAfterDrain();
    expect(killed).toBe(true);
    child.emit("close", 0);
    expect((await disconnect).hadSessionEvents).toBe(false);
  });

  test("a real session still sets hadSessionEvents, for contrast with the previous test", async () => {
    const child = fakeChild();
    const client = new StreamClient({
      command: "fake",
      reconnectOnExit: false,
      spawnFn: () => child as unknown as ChildProcess,
    });
    const disconnect = new Promise<{ hadSessionEvents: boolean }>((resolve) => client.once("disconnect", resolve));
    client.start();
    child.stdout.write(`${hello}\n{"t":"begin","session":1,"streaming":true,"session_elapsed_ms":0}\n`);
    child.emit("close", 0);
    expect((await disconnect).hadSessionEvents).toBe(true);
  });

  test("a refused record arriving mid-drain does not short-circuit the wait for the real session to end", () => {
    const order: string[] = [];
    const child = fakeChild(() => order.push("kill"));
    const client = new StreamClient({
      command: "fake",
      reconnectOnExit: false,
      spawnFn: () => child as unknown as ChildProcess,
    });
    client.on("event", ({ record }) => order.push(record.t));
    client.start();
    child.stdout.write(`${hello}\n{"t":"begin","session":1,"streaming":true,"session_elapsed_ms":0}\n`);
    client.stopAfterDrain();
    // A refusal for an unrelated command arrives while session 1 is still open and
    // #drainRequested is true. It must not be mistaken for the session ending: idle/refused/
    // start_failed never touch #activeSessions, so this must not trigger #killChild().
    child.stdout.write('{"t":"refused","mode":"assisted-notes","reason":"busy"}\n');
    expect(order).not.toContain("kill");
    child.stdout.write('{"t":"final","session":1,"speaker":"me","text":"done","session_elapsed_ms":10}\n');
    expect(order).toEqual(["hello", "begin", "refused", "final", "kill"]);
    child.emit("close", 0);
  });

  test("stopAfterDrain waits for the terminal event before killing the child", () => {
    const order: string[] = [];
    const child = fakeChild(() => order.push("kill"));
    const client = new StreamClient({
      command: "fake",
      reconnectOnExit: false,
      spawnFn: () => child as unknown as ChildProcess,
    });
    client.on("event", ({ record }) => order.push(record.t));
    client.start();
    child.stdout.write(`${hello}\n{"t":"begin","session":1,"streaming":true,"session_elapsed_ms":0}\n`);
    client.stopAfterDrain();
    expect(order).not.toContain("kill");
    child.stdout.write('{"t":"final","session":1,"speaker":"me","text":"done","session_elapsed_ms":10}\n');
    expect(order).toEqual(["hello", "begin", "final", "kill"]);
    child.emit("close", 0);
  });

  test("forceStop emits settled synchronously while reconnect backoff has no child", async () => {
    const child = fakeChild();
    const client = new StreamClient({
      command: "fake",
      backoffMs: [60_000],
      spawnFn: () => child as unknown as ChildProcess,
    });
    client.start();
    child.emit("close", 1);
    let settled = false;
    client.once("settled", () => { settled = true; });
    client.forceStop();
    expect(settled).toBe(true);
  });
});

function fakeChild(onKill: () => void = () => {}): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    onKill();
    return true;
  };
  return child;
}
