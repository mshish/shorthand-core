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
