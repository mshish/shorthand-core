import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { HandyControl, type ControlSignal } from "../src/stream/control.js";

type FakeStderr = PassThrough & { unref: () => void; unrefCount: number; resumeCount: number };

type FakeChild = EventEmitter & { stderr: FakeStderr; unref: () => void };

type SpawnCall = { command: string; args: string[]; options: unknown };

function fakeStderr(): FakeStderr {
  const stream = new PassThrough() as FakeStderr;
  stream.unrefCount = 0;
  stream.resumeCount = 0;
  // The real stderr is a net.Socket; the counters stand in for the two calls that keep
  // an abandoned child from pinning the host: unref() and drain-on-settle.
  stream.unref = () => { stream.unrefCount += 1; };
  const resume = stream.resume.bind(stream);
  stream.resume = () => { stream.resumeCount += 1; return resume(); };
  return stream;
}

function fakeChild(): FakeChild & { unrefCount: number } {
  const child = new EventEmitter() as FakeChild & { unrefCount: number };
  child.stderr = fakeStderr();
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  return child;
}

/**
 * Counts the timers that are still pending, so a leaked `setTimeout` — which in the
 * real process is a ref'd libuv handle holding the host's event loop open — is
 * observable rather than merely invisible.
 */
function trackTimers(): { pending: Set<unknown>; restore: () => void } {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Set<unknown>();
  globalThis.setTimeout = ((handler: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id: unknown = realSetTimeout(() => { pending.delete(id); handler(...args); }, ms);
    pending.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    pending.delete(id);
    realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
  }) as unknown as typeof clearTimeout;
  return {
    pending,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      for (const id of pending) realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
      pending.clear();
    },
  };
}

/** Deterministic flush: our listener is appended after the one under test, so it runs after it. */
async function writeStderr(child: FakeChild, text: string): Promise<void> {
  const delivered = new Promise<void>((resolve) => { child.stderr.once("data", () => resolve()); });
  child.stderr.write(text);
  await delivered;
}

function harness(): {
  calls: SpawnCall[];
  child: ReturnType<typeof fakeChild>;
  spawnFn: (command: string, args: string[], options: unknown) => ChildProcess;
} {
  const calls: SpawnCall[] = [];
  const child = fakeChild();
  return {
    calls,
    child,
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      return child as unknown as ChildProcess;
    },
  };
}

describe("HandyControl argv", () => {
  const signals: ControlSignal[] = ["toggle-transcription", "toggle-post-process", "cancel"];

  for (const signal of signals) {
    test(`spawns --${signal} as its own short-lived process`, async () => {
      const { calls, child, spawnFn } = harness();
      const control = new HandyControl({ command: "C:/handy/handy.exe", spawnFn, timeoutMs: 1_000 });
      const sent = control.send(signal);
      child.emit("close", 0);
      expect(await sent).toEqual({ status: "sent" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe("C:/handy/handy.exe");
      expect(calls[0]?.args).toEqual([`--${signal}`]);
    });
  }

  test("detaches, hides the window, and unrefs so the child cannot hold Obsidian open", async () => {
    const { calls, child, spawnFn } = harness();
    const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 1_000 });
    const sent = control.send("cancel");
    child.emit("close", 0);
    await sent;
    expect(calls[0]?.options).toMatchObject({
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: true,
    });
    expect(child.unrefCount).toBe(1);
  });

  test("unrefs the stderr pipe too: child.unref() alone leaves a ref'd libuv handle", async () => {
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 1_000 });
    const sent = control.send("cancel");
    expect(child.stderr.unrefCount).toBe(1);
    child.emit("close", 0);
    await sent;
  });
});

describe("HandyControl outcomes", () => {
  test("exit 0 means the flag reached the running instance", async () => {
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 1_000 });
    const sent = control.send("toggle-transcription");
    child.emit("close", 0);
    expect(await sent).toEqual({ status: "sent" });
  });

  test("non-zero exit carries the collected stderr", async () => {
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 1_000 });
    const sent = control.send("toggle-post-process");
    await writeStderr(child, "error: unexpected argument\n");
    child.emit("close", 2);
    expect(await sent).toEqual({ status: "error", message: "error: unexpected argument" });
  });

  test("non-zero exit without stderr still names the exit code", async () => {
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 1_000 });
    const sent = control.send("cancel");
    child.emit("close", 3);
    const result = await sent;
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toContain("3");
  });

  test("ENOENT names the resolved command path", async () => {
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "C:/missing/handy.exe", spawnFn, timeoutMs: 1_000 });
    const sent = control.send("cancel");
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    const result = await sent;
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toContain("C:/missing/handy.exe");
  });

  test("ENOENT wins over the close code Node emits right after it", async () => {
    // Probed against real Node with a missing exe and these spawn options:
    //   [["error","ENOENT"],["close",-4058,null]]
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "C:/missing/handy.exe", spawnFn, timeoutMs: 1_000 });
    const sent = control.send("cancel");
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    child.emit("close", -4058, null);
    const result = await sent;
    expect(result).toEqual({ status: "error", message: "Handy binary not found at C:/missing/handy.exe" });
  });

  test("a child still alive past the timeout means Handy was not running", async () => {
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 10 });
    // No close event: the process became the primary Tauri instance and launched the app.
    expect(await control.send("toggle-transcription")).toEqual({ status: "not-running" });
    expect(child.listenerCount("close")).toBe(1);
  });

  test("a child that exits first leaves no pending timer to hold the host open", async () => {
    const timers = trackTimers();
    try {
      const { child, spawnFn } = harness();
      // A minute: if the timeout is not cleared, it is still pending — and in the real
      // process still holding Obsidian's event loop — long after send() resolved.
      const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 60_000 });
      const sent = control.send("cancel");
      expect(timers.pending.size).toBe(1);
      child.emit("close", 0);
      expect(await sent).toEqual({ status: "sent" });
      expect(timers.pending.size).toBe(0);
    } finally {
      timers.restore();
    }
  });

  test("settles and releases the child exactly once when close follows the timeout", async () => {
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 10 });
    const sent = control.send("cancel");
    expect(await sent).toEqual({ status: "not-running" });
    expect(child.stderr.listenerCount("data")).toBe(0);
    const releasedOnce = child.stderr.resumeCount;

    // The child was abandoned, not killed: a late close must not release its stderr a
    // second time, and must not change the answer already handed to the caller.
    child.emit("close", 0);
    expect(await sent).toEqual({ status: "not-running" });
    expect(child.stderr.resumeCount).toBe(releasedOnce);
  });

  test("settling stops the abandoned child's stderr from accumulating for the session", async () => {
    const { child, spawnFn } = harness();
    const control = new HandyControl({ command: "handy", spawnFn, timeoutMs: 10 });
    const sent = control.send("toggle-transcription");
    expect(await sent).toEqual({ status: "not-running" });
    // Handy keeps logging for the rest of the session; none of it may be retained.
    child.stderr.write("[handy] log line\n");
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(child.stderr.readableLength).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });
});

describe("HandyControl.sendDetached", () => {
  test("returns synchronously and swallows an ENOENT error event", () => {
    const { calls, child, spawnFn } = harness();
    const control = new HandyControl({ command: "C:/missing/handy.exe", spawnFn });
    control.sendDetached("cancel");
    expect(calls[0]?.args).toEqual(["--cancel"]);
    expect(() => {
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    }).not.toThrow();
  });

  test("swallows a synchronous spawn failure", () => {
    const control = new HandyControl({
      command: "handy",
      spawnFn: () => { throw new Error("EPERM"); },
    });
    expect(() => control.sendDetached("toggle-transcription")).not.toThrow();
  });
});
