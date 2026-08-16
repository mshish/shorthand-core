import type { Section } from "../note/markers.js";
import type { NoteSink } from "../note/sink.js";

/**
 * The executable `NoteSink` contract.
 *
 * Every implementation must pass this suite unchanged. Nothing here may know
 * about files, paths, markers, hashes, or HTTP: a harness supplies the sink and
 * whatever transport-specific hooks the scenarios need, and the suite asserts
 * only against the port's own vocabulary.
 *
 * Design goal: this module is SHIPPED API, not a test. It therefore imports no
 * test runner. Every scenario is a plain async function that throws on failure,
 * so a Vitest, `node:test`, or bun consumer — in this repo or out of it — can run
 * the same contract by handing {@link describeNoteSinkConformance} its own
 * `describe`/`test` primitives, or by driving
 * {@link NOTE_SINK_CONFORMANCE_SCENARIOS} directly.
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

/** One contract scenario: throws on failure, resolves on success. */
export type SinkConformanceScenario = Readonly<{
  name: string;
  /** The optional capability this scenario needs, if any. */
  requires?: keyof SinkConformanceSupport;
  run(createHarness: SinkHarnessFactory): Promise<void>;
}>;

/* Assertion helpers. Deliberately dependency-free so no assertion library — and
 * in particular no test runner — leaks into shipped code. */

function fail(message: string): never {
  throw new Error(`NoteSink conformance: ${message}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function equalValues(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equalValues(item, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  const leftKeys = Object.keys(left as Record<string, unknown>).sort();
  const rightKeys = Object.keys(right as Record<string, unknown>).sort();
  if (!equalValues(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => equalValues(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
  ));
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (!equalValues(actual, expected)) fail(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

function assertNotEqual(actual: unknown, expected: unknown, what: string): void {
  if (equalValues(actual, expected)) fail(`${what}: expected a value other than ${show(expected)}`);
}

function assertStatus(result: { status: string }, expected: string, what: string): void {
  if (result.status !== expected) fail(`${what}: expected status "${expected}", got "${result.status}" (${show(result)})`);
}

function assertNonEmptyString(value: unknown, what: string): void {
  check(typeof value === "string" && value.length > 0, `${what}: expected a non-empty string, got ${show(value)}`);
}

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
  if (!result.ok) fail(`expected a readable target, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The contract, as data. Run them all; each is independent. */
export const NOTE_SINK_CONFORMANCE_SCENARIOS: readonly SinkConformanceScenario[] = [
  {
    name: "describes its target and reads sections, user notes, and one revision together",
    run: (createHarness) => withHarness(createHarness, async ({ sink }) => {
      assertNonEmptyString(sink.describe, "sink.describe");
      const snapshot = await readOk(sink);
      check(Array.isArray(snapshot.sections), "read().sections must be an array");
      check(typeof snapshot.userNotes === "string", "read().userNotes must be a string");
      assertNonEmptyString(snapshot.revision, "read().revision");
    }),
  },
  {
    name: "an offered agent context names a real working directory",
    run: (createHarness) => withHarness(createHarness, async ({ sink }) => {
      if (sink.agentContext === undefined) return;
      assertNonEmptyString(sink.agentContext.cwd, "agentContext.cwd");
    }),
  },
  {
    name: "revision is stable: reading twice without a mutation yields the same revision",
    run: (createHarness) => withHarness(createHarness, async ({ sink }) => {
      // A revision derived from wall-clock time passes every other test here and
      // then goes permanently stale in production, because the pass's own read
      // and its write straddle a tick.
      const first = await readOk(sink);
      const second = await readOk(sink);
      assertEqual(second.revision, first.revision, "revision must not move between two reads");
    }),
  },
  {
    name: "round-trips: sections written at a revision are the sections read back, and nothing else moves",
    run: (createHarness) => withHarness(createHarness, async ({ sink, sections, foreignSnapshot }) => {
      const before = await readOk(sink);
      const foreign = await foreignSnapshot();
      const written = await sink.write(sections, before.revision);
      assertStatus(written, "written", "write at a current revision");
      const after = await readOk(sink);
      assertEqual(after.sections, sections, "sections read back after a write");
      if (written.status === "written") assertEqual(after.revision, written.revision, "revision reported by write");
      assertNotEqual(after.revision, before.revision, "revision after a write");
      // The ownership invariant, on the path that actually writes: a sink owns its
      // sections and nothing else. Replacing the whole target is a data-loss bug
      // that every status-code assertion in this suite would otherwise miss.
      assertEqual(await foreignSnapshot(), foreign, "content the sink does not own");
      assertEqual(after.userNotes, before.userNotes, "user notes after a write");
    }),
  },
  {
    name: "reports unchanged, without a new revision, when the sections already match",
    run: (createHarness) => withHarness(createHarness, async ({ sink, sections }) => {
      const before = await readOk(sink);
      assertStatus(await sink.write(sections, before.revision), "written", "first write");
      const current = await readOk(sink);
      const repeat = await sink.write(sections, current.revision);
      assertStatus(repeat, "unchanged", "rewriting identical sections");
      if (repeat.status === "unchanged") assertEqual(repeat.revision, current.revision, "revision reported by unchanged");
      assertEqual((await readOk(sink)).revision, current.revision, "revision after an unchanged write");
    }),
  },
  {
    name: "reports stale for a superseded revision and leaves the target untouched",
    run: (createHarness) => withHarness(createHarness, async ({ sink, sections, mutateExternally, snapshot }) => {
      const before = await readOk(sink);
      await mutateExternally();
      const mutated = await snapshot();
      assertNotEqual((await readOk(sink)).revision, before.revision, "revision after an external mutation");
      assertEqual(await sink.write(sections, before.revision), { status: "stale" }, "write at a superseded revision");
      assertEqual(await snapshot(), mutated, "target after a stale write");
    }),
  },
  {
    name: "reports stale when the sink's own earlier write superseded the revision",
    run: (createHarness) => withHarness(createHarness, async ({ sink, sections, alternateSections, snapshot }) => {
      // Last-writer-wins between two passes holding the same revision would silently
      // discard the first pass's work, so staleness must not depend on the mutation
      // having come from outside.
      const before = await readOk(sink);
      assertStatus(await sink.write(sections, before.revision), "written", "first write");
      const afterFirst = await snapshot();
      assertEqual(await sink.write(alternateSections, before.revision), { status: "stale" }, "second write at the same revision");
      assertEqual(await snapshot(), afterFirst, "target after a self-superseded write");
      assertEqual((await readOk(sink)).sections, sections, "sections after a self-superseded write");
    }),
  },
  {
    name: "staleness outranks equality: identical sections at a stale revision are still stale",
    run: (createHarness) => withHarness(createHarness, async ({ sink, sections, mutateExternally }) => {
      // Pinned deliberately: concurrency is checked before content, so `unchanged`
      // always implies the caller held a current revision.
      const before = await readOk(sink);
      assertStatus(await sink.write(sections, before.revision), "written", "first write");
      const current = await readOk(sink);
      await mutateExternally();
      assertNotEqual((await readOk(sink)).revision, current.revision, "revision after an external mutation");
      assertEqual(await sink.write(sections, current.revision), { status: "stale" }, "identical sections at a stale revision");
    }),
  },
  {
    name: "busy is retryable and non-destructive: the same write succeeds once the target frees up",
    run: (createHarness) => withHarness(createHarness, async (harness) => {
      const { sink, sections, snapshot } = harness;
      const before = await readOk(sink);
      const untouched = await snapshot();
      const release = await harness.makeBusy();
      try {
        const busy = await sink.write(sections, before.revision);
        assertStatus(busy, "busy", "write against a busy target");
        if (busy.status === "busy" && busy.retryAfterMs !== undefined) {
          check(busy.retryAfterMs > 0, "busy.retryAfterMs must be positive when present");
        }
        assertEqual(await snapshot(), untouched, "target after a busy write");
      } finally {
        await release();
      }
      // The very same expected revision must still be accepted afterwards.
      assertStatus(await sink.write(sections, before.revision), "written", "retry after the target frees up");
      assertEqual((await readOk(sink)).sections, sections, "sections after a successful retry");
    }),
  },
  {
    name: "error leaves no partial write",
    run: (createHarness) => withHarness(createHarness, async ({ sink, invalidSections, snapshot }) => {
      const before = await readOk(sink);
      const untouched = await snapshot();
      const result = await sink.write(invalidSections, before.revision);
      assertStatus(result, "error", "write of unstorable sections");
      if (result.status === "error") {
        check(typeof result.error.code === "string", "error.code must be a string");
        assertNonEmptyString(result.error.message, "error.message");
      }
      assertEqual(await snapshot(), untouched, "target after a failed write");
      assertEqual((await readOk(sink)).revision, before.revision, "revision after a failed write");
    }),
  },
  {
    name: "a target that no longer exists reads as not-found",
    requires: "missing",
    run: (createHarness) => withHarness(createHarness, async ({ sink, makeMissing }) => {
      if (makeMissing === undefined) fail("support.missing requires a makeMissing() hook.");
      await makeMissing();
      const result = await sink.read();
      check(!result.ok, "a missing target must not read ok");
      if (!result.ok) assertEqual(result.error.code, "not-found", "read error code for a missing target");
    }),
  },
  {
    name: "a target the sink may not touch reads as forbidden",
    requires: "forbidden",
    run: (createHarness) => withHarness(createHarness, async ({ sink, makeForbidden }) => {
      if (makeForbidden === undefined) fail("support.forbidden requires a makeForbidden() hook.");
      await makeForbidden();
      const result = await sink.read();
      check(!result.ok, "a forbidden target must not read ok");
      if (!result.ok) assertEqual(result.error.code, "forbidden", "read error code for a forbidden target");
    }),
  },
];

/**
 * The minimal slice of a test runner the adapter needs. `bun:test`, Vitest and
 * `node:test` all satisfy it (for `node:test`, pass `describe`/`it` and omit
 * `todo`).
 */
export type ConformanceTestPrimitives = Readonly<{
  describe(name: string, body: () => void): unknown;
  test: ((name: string, body: () => Promise<void> | void) => unknown) & {
    /** Optional: runners without it simply omit unsupported scenarios. */
    todo?: (name: string, body: () => void) => unknown;
  };
}>;

/**
 * Register every scenario with a caller-supplied runner. Scenarios whose
 * capability the sink does not declare are reported as `todo` when the runner
 * supports it, so an unsupported shape is visible rather than silently absent.
 */
export function describeNoteSinkConformance(
  primitives: ConformanceTestPrimitives,
  name: string,
  createHarness: SinkHarnessFactory,
  support: SinkConformanceSupport = {},
): void {
  const { describe, test } = primitives;
  describe(`NoteSink conformance: ${name}`, () => {
    for (const scenario of NOTE_SINK_CONFORMANCE_SCENARIOS) {
      if (scenario.requires !== undefined && support[scenario.requires] !== true) {
        if (test.todo !== undefined) test.todo(scenario.name, () => {});
        continue;
      }
      test(scenario.name, () => scenario.run(createHarness));
    }
  });
}
