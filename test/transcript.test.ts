import { describe, expect, test } from "bun:test";
import type { WireEvent } from "../src/stream/client.js";
import { enhancementDelta, TranscriptStore } from "../src/stream/transcript.js";

const begin = (session: number): WireEvent => ({
  t: "begin",
  session,
  streaming: true,
  session_elapsed_ms: 0,
});
const partial = (session: number, speaker: "me" | "them", committed: string, elapsed: number, emitted_at?: string): WireEvent => ({
  t: "partial",
  session,
  speaker,
  committed,
  tentative: "",
  session_elapsed_ms: elapsed,
  ...(emitted_at === undefined ? {} : { emitted_at }),
});

describe("TranscriptStore", () => {
  test("keys speaker state by connection generation, session, and speaker", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(1));
    store.ingest(0, partial(1, "me", "before restart", 10));
    store.markConnectionEnded(0);
    store.ingest(1, begin(1));
    store.ingest(1, partial(1, "me", "after restart", 20));
    expect(store.snapshots().map((snapshot) => snapshot.speakers[0]?.text)).toEqual([
      "before restart",
      "after restart",
    ]);
  });

  test("emits only the newly committed suffix for extending snapshots", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(3));
    expect(store.ingest(0, partial(3, "me", "hello ", 100))).toMatchObject({ action: "append", delta: "hello " });
    expect(store.ingest(0, partial(3, "me", "hello world", 200))).toMatchObject({ action: "append", delta: "world" });
  });

  test("replaces a non-extending committed prefix and requests a tail rewrite", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(4));
    store.ingest(0, partial(4, "me", "hello", 100));
    const update = store.ingest(0, partial(4, "me", "hullo", 200));
    expect(update).toMatchObject({ action: "rewrite-tail", delta: "ullo", preservedPrefixLength: 1 });
    expect(update?.snapshot.speakers[0]?.text).toBe("hullo");
  });

  test("preserves commit timestamps for the surviving prefix of a rewritten tail", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(4));
    store.ingest(0, partial(4, "me", "hello", 100));
    const update = store.ingest(0, partial(4, "me", "help", 200));
    expect(update?.snapshot.commits).toEqual([
      expect.objectContaining({ text: "hel", commitMs: 100 }),
      expect.objectContaining({ text: "p", commitMs: 200 }),
    ]);
  });

  test("does not re-date a speaker lane for an identical snapshot", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(4));
    store.ingest(0, partial(4, "me", "hello", 100));
    expect(store.ingest(0, partial(4, "me", "hello", 900))).toBeNull();
    expect(store.snapshots()[0]?.speakers[0]?.commitMs).toBe(100);
  });

  test("single-lane final authoritatively replaces partial text", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(5));
    store.ingest(0, partial(5, "me", "hello world", 100));
    const update = store.ingest(0, {
      t: "final", session: 5, speaker: "me", text: "Hello, world.", session_elapsed_ms: 150,
    });
    expect(update).toMatchObject({ action: "replace-session", snapshot: { terminalReason: "final" } });
    expect(store.transcriptText()).toBe("Hello, world.");
  });

  test("final replacement sends only the previously unseen tail to enhancement", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(5));
    store.ingest(0, partial(5, "me", "hello world this is a long first chunk", 100));
    store.ingest(0, partial(5, "me", "hello world this is a long first chunk plus more", 120));
    const update = store.ingest(0, {
      t: "final", session: 5, speaker: "me", text: "Hello world, this is a long first chunk plus more.", session_elapsed_ms: 150,
    });
    expect(update).not.toBeNull();
    expect(enhancementDelta(update!)).not.toContain("Hello world, this is a long first chunk");
  });

  test("late lane interleaving emits only that lane delta and never re-sends later commits", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(12));
    enhancementDelta(store.ingest(0, partial(12, "me", "AAA", 100))!);
    enhancementDelta(store.ingest(0, partial(12, "me", "AAA BBB", 300))!);
    const lateLane = store.ingest(0, partial(12, "them", "ZZZ", 200));
    expect(enhancementDelta(lateLane!)).toBe("them: ZZZ");
    expect(enhancementDelta(lateLane!)).not.toContain("BBB");
  });

  test("dual-lane final without speaker replaces both partial lanes", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(6));
    store.ingest(0, partial(6, "me", "Can you hear me?", 100));
    store.ingest(0, partial(6, "them", "Yes", 200));
    store.ingest(0, {
      t: "final", session: 6, text: "Me: Can you hear me?\nThem: Yes, clearly.", session_elapsed_ms: 250,
    });
    expect(store.transcriptText()).toBe("Me: Can you hear me?\nThem: Yes, clearly.");
    expect(store.snapshots()[0]?.final?.speaker).toBeUndefined();
  });

  test("orders lanes by session_elapsed_ms and never emitted_at", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(7));
    store.ingest(0, partial(7, "me", "later commit", 200, "2000-01-01T00:00:00-05:00"));
    store.ingest(0, partial(7, "them", "earlier commit", 100, "2099-01-01T00:00:00-05:00"));
    expect(store.snapshots()[0]?.speakers.map((speaker) => speaker.speaker)).toEqual(["them", "me"]);
  });

  test("interleaves transcriptText by commit order", () => {
    const store = new TranscriptStore();
    store.ingest(0, begin(7));
    store.ingest(0, partial(7, "me", "first", 100));
    store.ingest(0, partial(7, "them", "second", 200));
    store.ingest(0, partial(7, "me", "first third", 300));
    expect(store.transcriptText()).toBe("me: first\nthem: second\nme:  third");
  });

  test("orders a stampless stream by monotonic arrival and marks commits unstamped", () => {
    const store = new TranscriptStore();
    store.ingest(0, { t: "begin", session: 11, streaming: true, unstamped: true });
    store.ingest(0, { t: "partial", session: 11, speaker: "me", committed: "one", tentative: "", unstamped: true });
    store.ingest(0, { t: "partial", session: 11, speaker: "them", committed: "two", tentative: "", unstamped: true });
    expect(store.snapshots()[0]?.commits).toEqual([
      expect.objectContaining({ speaker: "me", commitMs: 1, unstamped: true }),
      expect.objectContaining({ speaker: "them", commitMs: 2, unstamped: true }),
    ]);
  });

  test("distinguishes every terminal reason from an incomplete disconnect", () => {
    for (const terminal of ["final", "no_speech", "cancel", "error"] as const) {
      const store = new TranscriptStore();
      store.ingest(0, begin(8));
      const event: WireEvent = terminal === "final"
        ? { t: "final", session: 8, speaker: "me", text: "done", session_elapsed_ms: 10 }
        : terminal === "error"
          ? { t: "error", session: 8, message: "failed", session_elapsed_ms: 10 }
          : { t: terminal, session: 8, session_elapsed_ms: 10 };
      store.ingest(0, event);
      expect(store.snapshots()[0]).toMatchObject({ status: "terminal", terminalReason: terminal });
    }

    const disconnected = new TranscriptStore();
    disconnected.ingest(0, begin(9));
    expect(disconnected.markConnectionEnded(0)[0]?.snapshot.status).toBe("incomplete");
  });
});
