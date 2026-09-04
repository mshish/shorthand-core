import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { LlmProviderId } from "../agent/llm-credentials.js";
import type { ConformanceTestPrimitives } from "./sink-conformance.js";

/**
 * The executable contract for the LLM provider credentials file.
 *
 * Core READS this file and never writes it — `src/agent/llm-credentials.ts` says so and
 * ships no writer — so the contract has to be enforceable against a writer core knows
 * nothing about, in another process and possibly another language. Prose drifts; this does
 * not. Sibling of GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS and shipped under the same
 * rule: this module is SHIPPED API, not a test. It imports no test runner and no assertion
 * library, and every scenario is a plain async function that throws on failure, so a
 * second repository can run it under Vitest, `node:test`, or nothing at all.
 *
 * The language boundary is `write()`. A writer in another language supplies a harness that
 * shells out to itself; the scenarios never learn that it did.
 *
 * THE HARNESS MUST HAND OVER AN EMPTY DIRECTORY. See LlmCredentialsWriterHarness for the
 * precondition in full. It is not optional: a harness pointed at a real user's config
 * directory fails the debris scenario for reasons that have nothing to do with the writer.
 *
 * WHAT THESE SCENARIOS CANNOT SEE: atomicity itself. Every check runs after `write()` has
 * returned, so a plain truncate-then-write with no temp file and no rename passes all of
 * them — this suite observes the ABSENCE OF DEBRIS, which is a consequence of writing
 * atomically, not the atomicity. Whether the writer really writes a same-filesystem temp
 * file and renames it over the target has to be established by code review in the
 * implementing repository. Nobody should read "write-then-rename requirement" and conclude
 * that conformance checks it.
 *
 * WHY THE PERMISSIONS SCENARIO EXISTS AT ALL: this file usually carries a provider API key
 * in cleartext, and a key is a billable secret. It is gated on `support.posixPermissions`
 * rather than probed, and it is not emulated on Windows — a file there inherits the ACL of
 * %APPDATA%, and inventing an ACL assertion would be a second, unreviewed access-control
 * rule living only in a test suite.
 *
 * The runtime import of `../agent/llm-credentials.js` is deferred to `await import(...)`
 * inside the scenarios that need it. `shorthand-core/testing` is one barrel serving every
 * suite core publishes (see the header of ./index.ts), so a Markdown sink implementer
 * running the sink contract must not acquire core's agent module as a side effect of that
 * packaging choice. `node:fs/promises` and `node:path` are static on purpose: they are
 * built-ins already resolved in any process running this suite, so deferring them would
 * cost readability and buy nothing. The `LlmProviderId` import is type-only and erases.
 */

/**
 * What a conforming writer is asked to write.
 *
 * Declared here rather than aliased to `LlmCredentials` because the two describe opposite
 * ends of the file: `LlmCredentials` is what core's READER hands back, this is what a
 * WRITER must produce. They coincide today, and a future normalisation on the reading side
 * must not silently redefine what writers owe. `provider` is the one exception — it is
 * typed from core's own union so that adding a fourth provider id forces a new fixture
 * here rather than quietly leaving it untested.
 */
export type LlmCredentialsFixture = Readonly<{
  provider: LlmProviderId;
  model: string;
  /** Optional for EVERY provider, deliberately: see the round-trip scenario. */
  api_key?: string;
  /** Required only for `openai-compatible`, which names no endpoint of its own. */
  base_url?: string;
}>;

/**
 * PRECONDITION the harness must guarantee, and the one thing an implementer has to get
 * right before any scenario means anything:
 *
 * The directory the credentials file lands in is EMPTY (or does not yet exist) when the
 * factory returns, it is scratch space belonging to the writer under test ALONE for the
 * harness's lifetime, and a fresh one is handed over for every harness. Point the writer
 * at a temp directory and redirect whatever environment variable it uses to locate the
 * config directory; do not point it at a real user's.
 *
 * This is what lets the debris scenario assert that the directory holds EXACTLY the
 * credentials file and nothing else. Guessing from a name whether an entry looks temporary
 * is what the Google suite tried first, and it let through a writer that died between
 * write and rename leaving `.tmpAb3XyZ` — which is what Rust's `tempfile` crate names a
 * NamedTempFile by default. Any list of name shapes misses the convention the next
 * implementer happens to pick. An exact listing misses nothing.
 *
 * The cost is real and deliberate: a writer that keeps a sibling file of its own next to
 * the credentials fails, even though it is doing nothing dangerous. That is the trade. A
 * rule that admits "some other files are fine" cannot also say "no debris", because debris
 * is other files.
 *
 * A writer that owns the GOOGLE credentials file as well cannot share one scratch
 * directory between the two suites: both files live in the same config directory, so each
 * suite must be handed its own.
 */
export type LlmCredentialsWriterHarness = Readonly<{
  /**
   * Write these credentials wherever the implementation writes them, and report the path.
   *
   * The reported path is compared to core's `llmCredentialsPath()` by resolved location,
   * not by spelling, so any spelling of the same file is fine — forward slashes on
   * Windows, `..` segments, a symlinked temp root.
   */
  write(credentials: LlmCredentialsFixture): Promise<string>;
  dispose?(): Promise<void>;
}>;

export type LlmCredentialsHarnessFactory = () => Promise<LlmCredentialsWriterHarness>;

/**
 * Declared rather than probed, following the sink suite: a scenario that cannot run on
 * this platform shows up as a `todo` in the report instead of being silently absent.
 */
export type LlmCredentialsConformanceSupport = Readonly<{
  /** POSIX file modes are meaningful here. False/absent on Windows, where the file inherits %APPDATA%'s ACL. */
  posixPermissions?: boolean;
}>;

export type LlmCredentialsConformanceScenario = Readonly<{
  name: string;
  requires?: keyof LlmCredentialsConformanceSupport;
  run(createHarness: LlmCredentialsHarnessFactory): Promise<void>;
}>;

export type LlmCredentialsGoldenFixture = Readonly<{
  credentials: LlmCredentialsFixture;
  /** The exact file contents, byte for byte, including the trailing newline. */
  bytes: string;
}>;

const OPENAI: LlmCredentialsFixture = {
  provider: "openai",
  model: "gpt-4o-mini",
  api_key: "sk-conformance-openai-key",
};

/**
 * The "clear my key" profile: a hosted provider with no key at all.
 *
 * Written out rather than derived from OPENAI so that what it omits is visible where it is
 * defined — omission is the whole point of this fixture, and it is why core's reader makes
 * api_key optional for hosted providers too. A writer that refuses to persist a keyless
 * profile forces the user's model choice to be retyped after every key rotation.
 */
const OPENAI_KEYLESS: LlmCredentialsFixture = {
  provider: "openai",
  model: "gpt-4o-mini",
};

const ANTHROPIC: LlmCredentialsFixture = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  api_key: "sk-ant-conformance-key",
};

/**
 * Hostname under `.invalid`, the TLD RFC 2606 reserves for exactly this. Conformance runs
 * on other people's machines and in their CI; a fixture naming a plausible real host is
 * one careless `fetch` away from sending a stranger's suite somewhere it never intended.
 */
const OPENAI_COMPATIBLE: LlmCredentialsFixture = {
  provider: "openai-compatible",
  model: "llama-3.1-70b-instruct",
  api_key: "conformance-compatible-key",
  base_url: "https://conformance.invalid/v1",
};

/**
 * The keyless local endpoint — an Ollama-shaped profile, which needs no key and cannot be
 * reached without base_url. This is the variant a writer is most likely to get wrong,
 * because it is the one where api_key and base_url are not a pair: a writer that persists
 * the endpoint only alongside a key produces a file core's reader rejects outright.
 */
const OPENAI_COMPATIBLE_KEYLESS: LlmCredentialsFixture = {
  provider: "openai-compatible",
  model: "llama3.1",
  base_url: "http://127.0.0.1:11434/v1",
};

const OLLAMA: LlmCredentialsFixture = {
  provider: "ollama",
  model: "llama3.2",
};

/**
 * Canonical credentials paired with their exact expected bytes.
 *
 * Shipped as data, not as a serializer, because the writer is in another language: a unit
 * test over there can assert against these bytes with no JavaScript involved. Key ORDER is
 * part of the artifact — a byte comparison has no meaning without one — and it is the
 * order `LlmCredentials` declares: provider, model, api_key, base_url.
 *
 * An absent optional field is OMITTED, never written as null and never as an empty string:
 * both optional fields keep their slot in the order and simply do not appear when the
 * writer has no value, which is the same rule exactOptionalPropertyTypes imposes on the
 * types. Core's reader deliberately TOLERATES null and "" as absent so that an older core
 * survives a newer writer's idea of "cleared"; conformance does not, because a byte
 * comparison has no meaning without one spelling per state. The two keyless fixtures are
 * what make that rule binding rather than merely stated — while every fixture carried an
 * api_key, a writer serialising `Option<String>` without serde's `skip_serializing_if`
 * produced byte-perfect files for all of them.
 *
 * EXTRA KEYS FAIL, for the same reason and against the same reader tolerance. Adding a
 * field is a COORDINATED change: core gains a golden fixture here, the writer's repo picks
 * up the new version of this contract, and the field is agreed rather than discovered. The
 * reader's tolerance means shipping order does not have to be perfect; it does not mean
 * the field never has to be agreed.
 */
export const LLM_CREDENTIALS_FIXTURES: Readonly<{
  openai: LlmCredentialsGoldenFixture;
  openaiKeyless: LlmCredentialsGoldenFixture;
  anthropic: LlmCredentialsGoldenFixture;
  openaiCompatible: LlmCredentialsGoldenFixture;
  openaiCompatibleKeyless: LlmCredentialsGoldenFixture;
  ollama: LlmCredentialsGoldenFixture;
}> = Object.freeze({
  openai: Object.freeze({
    credentials: OPENAI,
    bytes: [
      "{",
      '  "provider": "openai",',
      '  "model": "gpt-4o-mini",',
      '  "api_key": "sk-conformance-openai-key"',
      "}",
      "",
    ].join("\n"),
  }),
  openaiKeyless: Object.freeze({
    credentials: OPENAI_KEYLESS,
    bytes: [
      "{",
      '  "provider": "openai",',
      '  "model": "gpt-4o-mini"',
      "}",
      "",
    ].join("\n"),
  }),
  anthropic: Object.freeze({
    credentials: ANTHROPIC,
    bytes: [
      "{",
      '  "provider": "anthropic",',
      '  "model": "claude-sonnet-4-5",',
      '  "api_key": "sk-ant-conformance-key"',
      "}",
      "",
    ].join("\n"),
  }),
  openaiCompatible: Object.freeze({
    credentials: OPENAI_COMPATIBLE,
    bytes: [
      "{",
      '  "provider": "openai-compatible",',
      '  "model": "llama-3.1-70b-instruct",',
      '  "api_key": "conformance-compatible-key",',
      '  "base_url": "https://conformance.invalid/v1"',
      "}",
      "",
    ].join("\n"),
  }),
  openaiCompatibleKeyless: Object.freeze({
    credentials: OPENAI_COMPATIBLE_KEYLESS,
    bytes: [
      "{",
      '  "provider": "openai-compatible",',
      '  "model": "llama3.1",',
      '  "base_url": "http://127.0.0.1:11434/v1"',
      "}",
      "",
    ].join("\n"),
  }),
  ollama: Object.freeze({
    credentials: OLLAMA,
    bytes: [
      "{",
      '  "provider": "ollama",',
      '  "model": "llama3.2"',
      "}",
      "",
    ].join("\n"),
  }),
});

/** Every golden fixture, in declaration order, for the scenarios that sweep all of them. */
const ALL_FIXTURES: readonly LlmCredentialsGoldenFixture[] = Object.values(LLM_CREDENTIALS_FIXTURES);

/** The closed set of keys the file may carry, in the order it must write them. */
const FIXTURE_KEYS = ["provider", "model", "api_key", "base_url"] as const;

/* Assertion helpers. Deliberately dependency-free so no assertion library — and in
 * particular no test runner — leaks into shipped code. */

function fail(message: string): never {
  throw new Error(`LLM credentials conformance: ${message}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (!Object.is(actual, expected)) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function withHarness(
  createHarness: LlmCredentialsHarnessFactory,
  body: (harness: LlmCredentialsWriterHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await body(harness);
  } finally {
    await harness.dispose?.();
  }
}

/**
 * Runs `body` once per golden fixture, each against its OWN harness.
 *
 * The Google suite runs its fixtures through a single harness, ordered so each is a
 * superset of the one before, which keeps a merging writer failing the overwrite scenario
 * alone. No such order exists here: `{provider, model, api_key}` and
 * `{provider, model, base_url}` are incomparable, so every possible sequence has a step
 * that drops a key and would collect a second, uninformative failure. A fresh harness per
 * fixture buys the same isolation without depending on an ordering that cannot be built.
 */
async function forEachFixture(
  createHarness: LlmCredentialsHarnessFactory,
  body: (golden: LlmCredentialsGoldenFixture, harness: LlmCredentialsWriterHarness) => Promise<void>,
): Promise<void> {
  for (const golden of ALL_FIXTURES) {
    await withHarness(createHarness, (harness) => body(golden, harness));
  }
}

async function directoryEntries(path: string): Promise<readonly string[]> {
  return [...await readdir(dirname(path))].sort();
}

/**
 * Asserts the writer's directory holds the credentials file and NOTHING else.
 *
 * Closed rather than open: see LlmCredentialsWriterHarness for why the harness owes an
 * empty directory, and for what this costs a writer that keeps sibling files.
 */
function assertOnlyEntry(entries: readonly string[], target: string, when: string): void {
  check(
    entries.length === 1 && entries[0] === target,
    `${when} the directory holds ${JSON.stringify(entries)}; ${JSON.stringify(target)} must be its only entry`,
  );
}

/**
 * Whether two paths name the same file, by location rather than by spelling.
 *
 * A raw string comparison fails a CORRECT writer, which is the worst failure a
 * cross-repository contract can have. A writer on Windows reports
 * `C:/Users/.../llm-credentials.json` with forward slashes; a path assembled from
 * components carries `..` hops; macOS's temp root is a symlink (`/var` -> `/private/var`).
 * All three name core's file and none of them match it character for character.
 *
 * Three widening steps, cheapest first. `resolve` settles separators and `..`. `realpath`
 * settles symlinks, and on Windows also drive-letter case. Device+inode is the last
 * resort, and is skipped when the inode is 0 — Windows reports that for files whose index
 * it cannot supply, and two zeroes are not evidence of anything.
 *
 * Duplicated from google-credentials-conformance.ts rather than shared so editing one
 * cannot silently change what the other asserts. A third suite would be the point to
 * extract a shared helper — two is not.
 */
async function sameFile(actual: string, expected: string): Promise<boolean> {
  if (resolve(actual) === resolve(expected)) return true;
  try {
    if (await realpath(actual) === await realpath(expected)) return true;
    const [a, b] = await Promise.all([stat(actual), stat(expected)]);
    return a.ino !== 0 && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

export const LLM_CREDENTIALS_CONFORMANCE_SCENARIOS: readonly LlmCredentialsConformanceScenario[] = [
  {
    name: "writes to core's own llmCredentialsPath(), not a re-derived one",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The scenario that stops a writer re-deriving the platform config directory and
      // drifting from core's. Core owns that resolution; a writer satisfies it. It also
      // pins the FILE NAME: a writer that invents `llm.json`, or one file per provider,
      // produces credentials core will never look at.
      //
      // Against core's own reference harness this scenario is vacuous — that harness calls
      // llmCredentialsPath() to decide where to write, so it compares the function to
      // itself. It earns its keep against the two callers that matter: the wrong-path
      // mutation in core's own mutation sweep, and a real external writer that computed
      // the path in another language.
      //
      // Compared as a LOCATION, not as a string; see sameFile for why that matters most on
      // exactly the platform this file's config directory is hardest to spell.
      const { llmCredentialsPath } = await import("../agent/llm-credentials.js");
      const reported = await write(LLM_CREDENTIALS_FIXTURES.openai.credentials);
      const expected = llmCredentialsPath();
      check(
        await sameFile(reported, expected),
        `reported write path ${JSON.stringify(reported)} is not core's llmCredentialsPath() ${JSON.stringify(expected)}`,
      );
    }),
  },
  {
    name: "core can read the file back with every field intact",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The richest profile — all four keys — so a writer that mangles a single field name
      // or value fails here with core's own reader message, before the byte comparison
      // reports the same problem in a form nobody can diff by eye.
      const { readLlmCredentials } = await import("../agent/llm-credentials.js");
      const fixture = LLM_CREDENTIALS_FIXTURES.openaiCompatible.credentials;
      const result = await readLlmCredentials(await write(fixture));
      if (!result.ok) fail(`core rejected the written file: ${result.message}`);
      for (const [key, expected] of Object.entries(fixture)) {
        assertEqual((result.value as Record<string, unknown>)[key], expected, `field ${key}`);
      }
    }),
  },
  {
    name: "every provider variant round-trips, including a keyless openai-compatible",
    run: (createHarness) => forEachFixture(createHarness, async (golden, { write }) => {
      // The matrix scenario, and the one that pins OMISSION as a state distinct from
      // "present but empty". Every hosted provider must survive having no api_key, because
      // that is what clearing a key leaves behind, and the alternative is a file core
      // rejects wholesale — taking the rest of the user's profile with it.
      // `openai-compatible` keyless is the case a writer is likeliest to break, since it is
      // the only one where base_url has to be persisted with no key beside it.
      const { readLlmCredentials } = await import("../agent/llm-credentials.js");
      const fixture = golden.credentials;
      const result = await readLlmCredentials(await write(fixture));
      if (!result.ok) fail(`core rejected ${JSON.stringify(fixture)}: ${result.message}`);
      for (const key of FIXTURE_KEYS) {
        const expected = (fixture as Record<string, unknown>)[key];
        const actual = (result.value as Record<string, unknown>)[key];
        if (expected === undefined) {
          check(
            !(key in result.value),
            `${key} was absent from ${JSON.stringify(fixture)} but came back as ${JSON.stringify(actual)}`,
          );
        } else {
          assertEqual(actual, expected, `${fixture.provider} field ${key}`);
        }
      }
    }),
  },
  {
    name: "an overwrite is wholesale: a key the second write omits is gone",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // Pins the absence of a merge. A writer that helpfully preserves fields it was not
      // given has invented a merge protocol, and a stale api_key outliving the key a user
      // deliberately cleared is the failure that costs them money.
      //
      // Asserted against the READ-BACK PROFILE rather than the raw JSON, so this scenario
      // answers one question only: did the old VALUE survive. Whether a cleared key is
      // spelled as an omission, as null, or as "" is a serialisation question the
      // golden-bytes scenario already owns — core's reader normalises all three to absent
      // — and one bug in a writer should not collect two failures.
      const { readLlmCredentials } = await import("../agent/llm-credentials.js");
      const first = LLM_CREDENTIALS_FIXTURES.openaiCompatible.credentials;
      const second = LLM_CREDENTIALS_FIXTURES.openaiCompatibleKeyless.credentials;
      await write(first);
      const result = await readLlmCredentials(await write(second));
      if (!result.ok) fail(`core rejected the overwritten file: ${result.message}`);
      check(
        !("api_key" in result.value),
        `api_key ${JSON.stringify((result.value as Record<string, unknown>).api_key)} survived an overwrite that omitted it`,
      );
      assertEqual(result.value.model, second.model, "model after overwrite");
      assertEqual(result.value.base_url, second.base_url, "base_url after overwrite");
    }),
  },
  {
    name: "a write leaves no temp-file debris behind",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The observable half of the write-then-rename requirement — and only that half:
      // atomicity itself is invisible from out here, see the note at the top of this file.
      //
      // Checked TWICE, because each catches a different writer. After the FIRST write: a
      // writer that dies between write and rename does so on whichever run it crashes,
      // including the first on a fresh machine — the realistic failure — and a baseline
      // taken after that write already contains the debris. After the SECOND: a writer
      // that cleans up on some paths but not others.
      //
      // The second write deliberately uses a DIFFERENT PROVIDER. A writer that files
      // credentials per provider — `llm-credentials.openai.json` beside the one core reads
      // — passes every other scenario here while leaving the key for the provider the user
      // just switched away from sitting on disk.
      //
      // EXACT listing, not a name-shape guess: that is what catches the temp-name
      // conventions nobody anticipated, and it rests entirely on the harness handing over
      // an empty, writer-owned directory.
      const first = await write(LLM_CREDENTIALS_FIXTURES.openaiCompatible.credentials);
      const target = basename(first);
      assertOnlyEntry(await directoryEntries(first), target, "after the first write");

      await write(LLM_CREDENTIALS_FIXTURES.openaiKeyless.credentials);
      assertOnlyEntry(await directoryEntries(first), target, "after a second write");
    }),
  },
  {
    name: "the file is mode 0600",
    requires: "posixPermissions",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // This file holds a billable secret in cleartext. Gated rather than emulated on
      // Windows — see the header.
      const path = await write(LLM_CREDENTIALS_FIXTURES.openai.credentials);
      assertEqual((await stat(path)).mode & 0o777, 0o600, "file mode");
    }),
  },
  {
    name: "the bytes match the golden fixture exactly",
    run: (createHarness) => forEachFixture(createHarness, async (golden, { write }) => {
      // Key order, indentation, the trailing newline and the closed set of keys, all at
      // once. Extra top-level keys fail here even though core's reader tolerates them at
      // runtime; the fixture doc gives the reason, and it is a coordinated change.
      const path = await write(golden.credentials);
      assertEqual(await readFile(path, "utf8"), golden.bytes, `file bytes for ${JSON.stringify(golden.credentials)}`);
    }),
  },
];

/**
 * Register every scenario with a caller-supplied runner. Scenarios whose capability the
 * platform does not declare are reported as `todo` when the runner supports it, so an
 * unrun scenario is visible rather than silently absent.
 */
export function describeLlmCredentialsConformance(
  primitives: ConformanceTestPrimitives,
  name: string,
  createHarness: LlmCredentialsHarnessFactory,
  support: LlmCredentialsConformanceSupport = {},
): void {
  const { describe, test } = primitives;
  describe(`LLM credentials conformance: ${name}`, () => {
    for (const scenario of LLM_CREDENTIALS_CONFORMANCE_SCENARIOS) {
      if (scenario.requires !== undefined && support[scenario.requires] !== true) {
        if (test.todo !== undefined) test.todo(scenario.name, () => {});
        continue;
      }
      test(scenario.name, () => scenario.run(createHarness));
    }
  });
}
