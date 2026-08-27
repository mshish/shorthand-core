import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NdjsonDecoder, StreamClient, type WireEvent } from "../src/stream/client.js";
import { SidecarWriter, type SidecarStore } from "shorthand-core";
import { TranscriptStore } from "../src/stream/transcript.js";

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const DOCUMENTED_SINGLE = `{"t":"hello","protocol":1,"version":"0.9.5","emitted_at":"2026-08-15T14:03:20.100-07:00"}
{"t":"begin","session":1,"streaming":true,"emitted_at":"2026-08-15T14:03:20.200-07:00","session_elapsed_ms":0}
{"t":"partial","session":1,"speaker":"me","committed":"hello ","tentative":"wor","emitted_at":"2026-08-15T14:03:21.412-07:00","session_elapsed_ms":1212}
{"t":"final","session":1,"speaker":"me","text":"Hello world.","emitted_at":"2026-08-15T14:03:22.050-07:00","session_elapsed_ms":1850}
{"t":"no_speech","session":1,"emitted_at":"...","session_elapsed_ms":700}
{"t":"cancel","session":1,"emitted_at":"...","session_elapsed_ms":700}
{"t":"error","session":1,"message":"transcription failed","emitted_at":"...","session_elapsed_ms":900}`;

const DOCUMENTED_DUAL = `{"t":"hello","protocol":1,"version":"0.9.5","emitted_at":"2026-08-15T14:03:20.100-07:00"}
{"t":"begin","session":42,"streaming":true,"emitted_at":"2026-08-15T14:03:20.200-07:00","session_elapsed_ms":0}
{"t":"partial","session":42,"speaker":"me","committed":"Can you hear me?","tentative":"","emitted_at":"2026-08-15T14:03:21.412-07:00","session_elapsed_ms":1212}
{"t":"partial","session":42,"speaker":"them","committed":"Yes, clearly.","tentative":"","emitted_at":"2026-08-15T14:03:22.900-07:00","session_elapsed_ms":2700}
{"t":"final","session":42,"text":"Me: Can you hear me?\\nThem: Yes, clearly.","emitted_at":"2026-08-15T14:03:23.010-07:00","session_elapsed_ms":2810}`;

describe("documented protocol contract", () => {
  test("literal FOLLOW_STREAM.md JSONL blocks produce the authoritative final transcript", () => {
    const store = new TranscriptStore();
    const decoder = new NdjsonDecoder((record) => {
      if (!(record.t === "error" && !("session" in record))) store.ingest(0, record as WireEvent);
    });
    decoder.push(Buffer.from(`${DOCUMENTED_SINGLE}\n${DOCUMENTED_DUAL}`));
    decoder.end();
    expect(store.transcriptText()).toBe(
      "Hello world.\n\nMe: Can you hear me?\nThem: Yes, clearly.",
    );
  });
});

describe("SidecarWriter", () => {
  test("uses a retry-safe store transaction without leaking discarded callback state", async () => {
    const existing = "# Shorthand Transcript\n\nExisting capture.\n";
    const store = new RetryingMemoryStore("memory://transcript", existing);
    const writer = new SidecarWriter("ignored.md", {
      store,
      now: () => new Date("2026-08-15T18:00:00.000Z"),
    });
    expect(writer.path).toBe("memory://transcript");
    await writer.close();
    expect(store.calls).toBe(2);
    expect((store.content ?? "").match(/## Resumed 2026-08-15T18:00:00.000Z/g)).toHaveLength(1);
    expect(store.content).toContain("Concurrent append.");
  });

  test("rejects ambiguous custom-store and filesystem configuration", () => {
    const store: SidecarStore = {
      describe: "memory://transcript",
      process: async (transform) => transform(undefined).value,
    };
    expect(() => new SidecarWriter("ignored.md", { store, fileSystem: {} }))
      .toThrow("mutually exclusive");
  });

  test("detects deletion and outside mutation through a custom store", async () => {
    const store = new MemoryStore("memory://transcript");
    const writer = new SidecarWriter("ignored.md", { store, flushIntervalMs: 10_000 });
    await writer.flush();
    store.content = undefined;
    await expect(writer.flush()).rejects.toThrow("disappeared during capture");

    const secondStore = new MemoryStore("memory://second");
    const second = new SidecarWriter("ignored.md", { store: secondStore, flushIntervalMs: 10_000 });
    await second.flush();
    secondStore.content += "\noutside";
    await expect(second.flush()).rejects.toThrow("changed outside Shorthand");
  });

  test("coalesces partials, rewrites a resynced tail, reconciles final, and labels commit time", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".sidecar-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "transcript.md");
    const writer = new SidecarWriter(path, { flushIntervalMs: 10_000 });
    const store = new TranscriptStore();
    const apply = (event: WireEvent) => {
      const update = store.ingest(0, event);
      if (update !== null) writer.apply(update);
    };
    apply({ t: "begin", session: 1, streaming: true, session_elapsed_ms: 0 });
    apply({ t: "partial", session: 1, speaker: "me", committed: "hello", tentative: "", session_elapsed_ms: 100 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(readFile(path, "utf8")).rejects.toThrow();
    await writer.flush();
    const firstCommit = writer.render();
    apply({ t: "partial", session: 1, speaker: "me", committed: "hello world", tentative: "", session_elapsed_ms: 150 });
    expect(writer.render().startsWith(firstCommit)).toBe(true);
    apply({ t: "partial", session: 1, speaker: "me", committed: "hullo", tentative: "", session_elapsed_ms: 200 });
    expect(writer.render()).not.toContain("hello world");
    apply({ t: "final", session: 1, speaker: "me", text: "Hullo.", session_elapsed_ms: 250 });
    writer.addReconnectWarning(1);
    await writer.close();
    const content = await readFile(path, "utf8");
    expect(content).toContain("**[COMMIT +00:00.250] me:** Hullo.");
    expect(content).not.toContain("hello");
    expect(content).toContain("> [!warning] Transcript gap");
    expect(content).toContain("when text became committed—not speech time");
  });

  test("preserves a pre-existing sidecar and appends a resumed section", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".sidecar-resume-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "transcript.md");
    const existing = "# Shorthand Transcript\n\n## Earlier capture\n\nNever lose this.\n";
    await writeFile(path, existing, "utf8");
    const writer = new SidecarWriter(path, {
      flushIntervalMs: 10_000,
      now: () => new Date("2026-08-15T18:00:00.000Z"),
    });
    await writer.close();
    const content = await readFile(path, "utf8");
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain("## Resumed 2026-08-15T18:00:00.000Z");
    expect(content).toContain("Never lose this.");
  });

  test("refuses to overwrite an existing file without the sidecar sentinel", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".sidecar-sentinel-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "meeting-note.md");
    await writeFile(path, "# User meeting note\n\nDo not overwrite.\n", "utf8");
    const writer = new SidecarWriter(path);
    await expect(writer.close()).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(path, "utf8")).toContain("Do not overwrite.");
  });

  test("recovers after one atomic write error and emits writeError", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".sidecar-recovery-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "transcript.md");
    let failNextWrite = true;
    const flakyOpen = (async (path: string, flags: string) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("simulated disk error");
      }
      return open(path, flags as "wx");
    }) as unknown as typeof open;
    const writer = new SidecarWriter(path, {
      flushIntervalMs: 10_000,
      fileSystem: { open: flakyOpen },
    });
    const errors: Error[] = [];
    writer.on("writeError", ({ error }) => errors.push(error));
    const store = new TranscriptStore();
    const update = store.ingest(0, { t: "begin", session: 1, streaming: true, session_elapsed_ms: 0 });
    if (update !== null) writer.apply(update);
    await expect(writer.flush()).rejects.toThrow("simulated disk error");
    await writer.close();
    expect(errors.map((error) => error.message)).toEqual(["simulated disk error"]);
    expect(await readFile(path, "utf8")).toContain("## Connection 0 · Session 1");
  });

  test("syncs and closes an exclusive temporary file before rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".sidecar-fsync-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "transcript.md");
    const order: string[] = [];
    const fakeOpen = (async () => ({
      writeFile: async () => { order.push("write"); },
      sync: async () => { order.push("sync"); },
      close: async () => { order.push("close"); },
    }) as unknown as Awaited<ReturnType<typeof open>>) as typeof open;
    const writer = new SidecarWriter(path, {
      fileSystem: {
        open: fakeOpen,
        rename: async () => { order.push("rename"); },
      },
    });
    await writer.close();
    expect(order).toEqual(["write", "sync", "close", "rename"]);
  });

  test("does not silently recreate a sidecar deleted during capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".sidecar-delete-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "transcript.md");
    const writer = new SidecarWriter(path, { flushIntervalMs: 10_000 });
    const store = new TranscriptStore();
    const begin = store.ingest(0, { t: "begin", session: 1, streaming: true, session_elapsed_ms: 0 });
    if (begin !== null) writer.apply(begin);
    await writer.flush();
    await rm(path);
    const partial = store.ingest(0, {
      t: "partial",
      session: 1,
      speaker: "me",
      committed: "still recording",
      tentative: "",
      session_elapsed_ms: 10,
    });
    if (partial !== null) writer.apply(partial);
    await expect(writer.flush()).rejects.toThrow("Sidecar disappeared during capture");
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  test("renders an incomplete session, inline gap, then the reconnected generation end to end", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".sidecar-reconnect-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "transcript.md");
    const statePath = join(directory, "fixture-state.txt");
    const fixture = join(process.cwd(), "test", "fixtures", "fake-stream-reconnect.mjs");
    const writer = new SidecarWriter(path, { flushIntervalMs: 10_000 });
    const store = new TranscriptStore();
    const client = new StreamClient({
      command: process.execPath,
      args: [fixture],
      backoffMs: [0],
      maxReconnectAttempts: 2,
      spawnFn: (command, args, options) => spawn(command, args, {
        ...options,
        env: { ...process.env, SHORTHAND_FAKE_STATE: statePath },
      }),
    });
    client.on("event", ({ generation, record }) => {
      const update = store.ingest(generation, record);
      if (update !== null) writer.apply(update);
      if (generation === 1 && record.t === "final") client.forceStop();
    });
    client.on("disconnect", ({ generation }) => {
      for (const update of store.markConnectionEnded(generation)) writer.apply(update);
    });
    client.on("reconnect", ({ generation, gap }) => {
      if (gap) writer.addReconnectWarning(generation);
    });
    const settled = new Promise<void>((resolve) => client.once("settled", () => resolve()));
    client.start();
    await settled;
    await writer.close();
    const content = await readFile(path, "utf8");
    const incomplete = content.indexOf("> [!warning] Incomplete session");
    const gap = content.indexOf("> [!warning] Transcript gap");
    const reconnected = content.indexOf("## Connection 1 · Session 1");
    expect(incomplete).toBeGreaterThan(-1);
    expect(gap).toBeGreaterThan(incomplete);
    expect(reconnected).toBeGreaterThan(gap);
    expect(content).toContain("After gap.");
  }, 10_000);
});

class MemoryStore implements SidecarStore {
  constructor(readonly describe: string, public content?: string) {}

  async process<T>(
    transform: (current: string | undefined) => Readonly<{ content: string; value: T }>,
  ): Promise<T> {
    const candidate = transform(this.content);
    this.content = candidate.content;
    return candidate.value;
  }
}

class RetryingMemoryStore extends MemoryStore {
  calls = 0;

  override async process<T>(
    transform: (current: string | undefined) => Readonly<{ content: string; value: T }>,
  ): Promise<T> {
    this.calls += 1;
    transform(this.content);
    this.content = `${this.content}\nConcurrent append.`;
    this.calls += 1;
    return super.process(transform);
  }
}
