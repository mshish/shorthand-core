import { describe, expect, test } from "bun:test";
import type { Section } from "../../src/note/markers.js";
import type { NoteSink } from "../../src/note/sink.js";

/**
 * The executable `NoteSink` contract.
 *
 * Every implementation must pass this suite unchanged. Nothing here may know
 * about files, paths, markers, hashes, or HTTP: a harness supplies the sink and
 * whatever transport-specific hooks the scenarios need, and the suite asserts
 * only against the port's own vocabulary.
 */
export type SinkHarness = Readonly<{
  /** A fresh sink whose target already exists and can be read. */
  sink: NoteSink;
  /** Sections the round-trip and unchanged scenarios write. Must be storable. */
  sections: readonly Section[];
  /** Different storable sections, for the concurrent-write scenarios. */
  alternateSections: readonly Section[];
  /** Sections this sink must refuse with `error` rather than store. */
  invalidSections: readonly Section[];
  /** Change the target outside the sink so its revision moves. */
  mutateExternally(): Promise<void>;
  /**
   * Put the target into a transient busy state (lock held, `429` in force) and
   * return the release. Required: busy is the most transport-specific behaviour
   * in the port, so a sink that cannot demonstrate it has not been tested.
   */
  makeBusy(): Promise<() => Promise<void>>;
  /** Make the target cease to exist, for the `not-found` read shape. */
  makeMissing?(): Promise<void>;
  /** Make the target unwritable/unauthorised, for the `forbidden` read shape. */
  makeForbidden?(): Promise<void>;
  /**
   * An opaque snapshot of the entire target, compared only for equality. It must
   * cover content the sink does not own, so destructive writes are detectable.
   */
  snapshot(): Promise<string>;
  /**
   * An opaque snapshot of ONLY the content this sink must never own — the
   * surrounding page, the user's own prose, neighbouring blocks. A successful
   * write must leave it byte-identical; a sink that replaces its whole target
   * fails here even though every status code it returns is correct.
   */
  foreignSnapshot(): Promise<string>;
  dispose?(): Promise<void>;
}>;

/**
 * Which optional read-error shapes this sink can be driven into. Declared rather
 * than probed so a transport that cannot produce one shows up as a `todo` in the
 * report instead of a silently passing test.
 */
export type SinkConformanceSupport = Readonly<{
  missing?: boolean;
  forbidden?: boolean;
}>;

export type SinkHarnessFactory = () => Promise<SinkHarness>;

async function withHarness(
  createHarness: SinkHarnessFactory,
  body: (harness: SinkHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await body(harness);
  } finally {
    await harness.dispose?.();
  }
}

async function readOk(sink: NoteSink) {
  const result = await sink.read();
  if (!result.ok) throw new Error(`Expected a readable target, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

export function describeNoteSinkConformance(
  name: string,
  createHarness: SinkHarnessFactory,
  support: SinkConformanceSupport = {},
): void {
  describe(`NoteSink conformance: ${name}`, () => {
    test("describes its target and reads sections, user notes, and one revision together", async () => {
      await withHarness(createHarness, async ({ sink }) => {
        expect(typeof sink.describe).toBe("string");
        expect(sink.describe.length).toBeGreaterThan(0);
        const snapshot = await readOk(sink);
        expect(Array.isArray(snapshot.sections)).toBe(true);
        expect(typeof snapshot.userNotes).toBe("string");
        expect(typeof snapshot.revision).toBe("string");
        expect(snapshot.revision.length).toBeGreaterThan(0);
      });
    });

    test("an offered agent context names a real working directory", async () => {
      await withHarness(createHarness, async ({ sink }) => {
        if (sink.agentContext === undefined) return;
        expect(typeof sink.agentContext.cwd).toBe("string");
        expect(sink.agentContext.cwd.length).toBeGreaterThan(0);
      });
    });

    test("revision is stable: reading twice without a mutation yields the same revision", async () => {
      await withHarness(createHarness, async ({ sink }) => {
        // A revision derived from wall-clock time passes every other test here and
        // then goes permanently stale in production, because the pass's own read
        // and its write straddle a tick.
        const first = await readOk(sink);
        const second = await readOk(sink);
        expect(second.revision).toBe(first.revision);
      });
    });

    test("round-trips: sections written at a revision are the sections read back, and nothing else moves", async () => {
      await withHarness(createHarness, async ({ sink, sections, foreignSnapshot }) => {
        const before = await readOk(sink);
        const foreign = await foreignSnapshot();
        const written = await sink.write(sections, before.revision);
        expect(written.status).toBe("written");
        const after = await readOk(sink);
        expect(after.sections).toEqual(sections);
        if (written.status === "written") expect(after.revision).toBe(written.revision);
        expect(after.revision).not.toBe(before.revision);
        // The ownership invariant, on the path that actually writes: a sink owns its
        // sections and nothing else. Replacing the whole target is a data-loss bug
        // that every status-code assertion in this suite would otherwise miss.
        expect(await foreignSnapshot()).toBe(foreign);
        expect(after.userNotes).toBe(before.userNotes);
      });
    });

    test("reports unchanged, without a new revision, when the sections already match", async () => {
      await withHarness(createHarness, async ({ sink, sections }) => {
        const before = await readOk(sink);
        expect((await sink.write(sections, before.revision)).status).toBe("written");
        const current = await readOk(sink);
        const repeat = await sink.write(sections, current.revision);
        expect(repeat.status).toBe("unchanged");
        if (repeat.status === "unchanged") expect(repeat.revision).toBe(current.revision);
        expect((await readOk(sink)).revision).toBe(current.revision);
      });
    });

    test("reports stale for a superseded revision and leaves the target untouched", async () => {
      await withHarness(createHarness, async ({ sink, sections, mutateExternally, snapshot }) => {
        const before = await readOk(sink);
        await mutateExternally();
        const mutated = await snapshot();
        expect((await readOk(sink)).revision).not.toBe(before.revision);
        expect(await sink.write(sections, before.revision)).toEqual({ status: "stale" });
        expect(await snapshot()).toBe(mutated);
      });
    });

    test("reports stale when the sink's own earlier write superseded the revision", async () => {
      await withHarness(createHarness, async ({ sink, sections, alternateSections, snapshot }) => {
        // Last-writer-wins between two passes holding the same revision would silently
        // discard the first pass's work, so staleness must not depend on the mutation
        // having come from outside.
        const before = await readOk(sink);
        expect((await sink.write(sections, before.revision)).status).toBe("written");
        const afterFirst = await snapshot();
        expect(await sink.write(alternateSections, before.revision)).toEqual({ status: "stale" });
        expect(await snapshot()).toBe(afterFirst);
        expect((await readOk(sink)).sections).toEqual(sections);
      });
    });

    test("staleness outranks equality: identical sections at a stale revision are still stale", async () => {
      await withHarness(createHarness, async ({ sink, sections, mutateExternally }) => {
        // Pinned deliberately: concurrency is checked before content, so `unchanged`
        // always implies the caller held a current revision.
        const before = await readOk(sink);
        expect((await sink.write(sections, before.revision)).status).toBe("written");
        const current = await readOk(sink);
        await mutateExternally();
        expect((await readOk(sink)).revision).not.toBe(current.revision);
        expect(await sink.write(sections, current.revision)).toEqual({ status: "stale" });
      });
    });

    test("busy is retryable and non-destructive: the same write succeeds once the target frees up", async () => {
      await withHarness(createHarness, async (harness) => {
        const { sink, sections, snapshot } = harness;
        const before = await readOk(sink);
        const untouched = await snapshot();
        const release = await harness.makeBusy();
        try {
          const busy = await sink.write(sections, before.revision);
          expect(busy.status).toBe("busy");
          if (busy.status === "busy" && busy.retryAfterMs !== undefined) {
            expect(busy.retryAfterMs).toBeGreaterThan(0);
          }
          expect(await snapshot()).toBe(untouched);
        } finally {
          await release();
        }
        // The very same expected revision must still be accepted afterwards.
        const retried = await sink.write(sections, before.revision);
        expect(retried.status).toBe("written");
        expect((await readOk(sink)).sections).toEqual(sections);
      });
    });

    test("error leaves no partial write", async () => {
      await withHarness(createHarness, async ({ sink, invalidSections, snapshot }) => {
        const before = await readOk(sink);
        const untouched = await snapshot();
        const result = await sink.write(invalidSections, before.revision);
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(typeof result.error.code).toBe("string");
          expect(result.error.message.length).toBeGreaterThan(0);
        }
        expect(await snapshot()).toBe(untouched);
        expect((await readOk(sink)).revision).toBe(before.revision);
      });
    });

    const missingName = "a target that no longer exists reads as not-found";
    if (support.missing === true) {
      test(missingName, async () => {
        await withHarness(createHarness, async ({ sink, makeMissing }) => {
          if (makeMissing === undefined) throw new Error("support.missing requires a makeMissing() hook.");
          await makeMissing();
          const result = await sink.read();
          expect(result).toMatchObject({ ok: false, error: { code: "not-found" } });
        });
      });
    } else test.todo(missingName, () => {});

    const forbiddenName = "a target the sink may not touch reads as forbidden";
    if (support.forbidden === true) {
      test(forbiddenName, async () => {
        await withHarness(createHarness, async ({ sink, makeForbidden }) => {
          if (makeForbidden === undefined) throw new Error("support.forbidden requires a makeForbidden() hook.");
          await makeForbidden();
          const result = await sink.read();
          expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
        });
      });
    } else test.todo(forbiddenName, () => {});
  });
}
