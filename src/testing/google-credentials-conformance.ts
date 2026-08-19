import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ConformanceTestPrimitives } from "./sink-conformance.js";

/**
 * The executable contract for the Google credentials file.
 *
 * Core READS this file and never writes it, so the contract has to be enforceable
 * against a writer core knows nothing about — in another process, in another language.
 * Prose drifts; this does not. Modelled on NOTE_SINK_CONFORMANCE_SCENARIOS, and shipped
 * under the same rule: this module is SHIPPED API, not a test. It imports no test runner
 * and no assertion library, and every scenario is a plain async function that throws on
 * failure.
 *
 * The language boundary is `write()`. A writer in another language supplies a harness
 * that shells out to itself; the scenarios never know about it, exactly as SinkHarness
 * already hides transport from the sink scenarios.
 *
 * THE HARNESS MUST HAND OVER AN EMPTY DIRECTORY. See CredentialsWriterHarness for the
 * precondition in full; it is not optional, and a harness pointed at a real user's config
 * directory will fail the debris scenario for reasons that have nothing to do with the
 * writer.
 *
 * WHAT THESE SCENARIOS CANNOT SEE: atomicity itself. Every check here runs after `write()`
 * has returned, so a plain truncate-then-write with no temp file and no rename passes all
 * of them — the suite observes the ABSENCE OF DEBRIS, which is a consequence of doing the
 * write atomically, not the atomicity. Whether the writer actually writes to a
 * same-filesystem temp file and renames it over the target has to be established by code
 * review in the implementing repository. Nobody should read "write-then-rename
 * requirement" and conclude that conformance checks it: a reader mid-capture can observe a
 * torn file that this suite would call conformant.
 *
 * Two imports are deferred to `await import(...)` inside the scenarios that use them:
 * `google-auth-library` and `../google/file-token-provider.js`. `shorthand-core/testing`
 * is one barrel serving both suites, and a Markdown sink implementer running the sink
 * contract must not acquire google-auth-library, or core's Google module, as a side
 * effect of that packaging choice. `node:fs/promises` and `node:path` are imported
 * statically on purpose: they are Node built-ins already resolved in any process running
 * this suite, so deferring them would cost readability and buy nothing.
 */

export type CredentialsFixture = Readonly<{
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** Optional, mirroring GoogleCredentials: a credential with no target is still a credential. */
  document_id?: string;
  folder_id?: string;
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
 * credentials file and nothing else. The alternative — guessing from a name whether an
 * entry looks temporary — is what an earlier version of this contract did, and it let
 * through a writer that died between write and rename leaving `.tmpAb3XyZ`, which is
 * precisely what Rust's `tempfile` crate names a NamedTempFile by default. Any list of
 * name shapes misses the convention the next implementer happens to pick. An exact
 * listing misses nothing.
 *
 * The cost is real and deliberate: a writer that also keeps a sibling file of its own —
 * `last-sync.json` next to the credentials — fails, even though it is doing nothing
 * dangerous. That is the trade. A rule that admits "some other files are fine" cannot
 * also say "no debris", because debris is other files.
 */
export type CredentialsWriterHarness = Readonly<{
  /**
   * Write these credentials wherever the implementation writes them, and report the path.
   *
   * The reported path is compared to core's `credentialsPath()` by resolved location, not
   * by spelling, so any spelling of the same file is fine — forward slashes on Windows,
   * `..` segments, a symlinked temp root.
   */
  write(credentials: CredentialsFixture): Promise<string>;
  dispose?(): Promise<void>;
}>;

export type CredentialsHarnessFactory = () => Promise<CredentialsWriterHarness>;

/**
 * Declared rather than probed, following the sink suite: a scenario that cannot run on
 * this platform shows up as a `todo` in the report instead of being silently absent.
 */
export type CredentialsConformanceSupport = Readonly<{
  /** POSIX file modes are meaningful here. False/absent on Windows, where the file inherits %APPDATA%'s ACL. */
  posixPermissions?: boolean;
}>;

export type CredentialsConformanceScenario = Readonly<{
  name: string;
  requires?: keyof CredentialsConformanceSupport;
  run(createHarness: CredentialsHarnessFactory): Promise<void>;
}>;

export type CredentialsGoldenFixture = Readonly<{
  credentials: CredentialsFixture;
  /** The exact file contents, byte for byte, including the trailing newline. */
  bytes: string;
}>;

const MINIMAL: CredentialsFixture = {
  type: "authorized_user",
  client_id: "1234567890-conformance.apps.googleusercontent.com",
  client_secret: "conformance-client-secret",
  refresh_token: "conformance-refresh-token",
  document_id: "conformance-document-id",
};

const WITH_FOLDER: CredentialsFixture = { ...MINIMAL, folder_id: "conformance-folder-id" };

/**
 * The four ADC fields and nothing else. Written out rather than derived from MINIMAL so
 * that what it omits is visible at the point of definition — omission is the whole point
 * of this fixture.
 */
const WITHOUT_TARGET: CredentialsFixture = {
  type: "authorized_user",
  client_id: MINIMAL.client_id,
  client_secret: MINIMAL.client_secret,
  refresh_token: MINIMAL.refresh_token,
};

/**
 * Canonical credentials paired with their exact expected bytes.
 *
 * Shipped as data, not as a serializer, because the writer is in another language: a
 * unit test over there can assert against these bytes with no JavaScript involved. Key
 * ORDER is part of the artifact — a byte comparison has no meaning without one — and it
 * is the order the file's own documentation gives: Google's four first, ours after.
 *
 * An absent optional field is OMITTED, never written as null: `document_id` and
 * `folder_id` both keep their slot in the order and simply do not appear when the writer
 * has no value, which is the same rule exactOptionalPropertyTypes imposes on the types.
 * `withoutTarget` exists to make that rule binding rather than merely stated. While every
 * fixture carried a document_id, a writer serialising `Option<String>` without serde's
 * `skip_serializing_if` emitted `"document_id": null` and produced byte-perfect files for
 * all of them.
 *
 * EXTRA KEYS FAIL, and that is deliberate, not an oversight against the reader. Core's
 * `readCredentials` drops unknown top-level keys on purpose, so an older core keeps
 * working against a newer writer that added a field — that is a RUNTIME tolerance, and it
 * stays. Conformance is stricter than runtime on purpose: a byte comparison has no
 * meaning without a closed set of keys, and a shared file format whose two repositories
 * can each add fields unilaterally is how the two ends drift apart. Adding a field is
 * therefore a COORDINATED change: core gains a new golden fixture here, the writer's repo
 * picks up the new version of this contract, and the field is agreed rather than
 * discovered. The reader's tolerance means shipping order does not have to be perfect;
 * it does not mean the field never has to be agreed.
 */
export const GOOGLE_CREDENTIALS_FIXTURES: Readonly<{
  minimal: CredentialsGoldenFixture;
  withFolder: CredentialsGoldenFixture;
  withoutTarget: CredentialsGoldenFixture;
}> = Object.freeze({
  minimal: Object.freeze({
    credentials: MINIMAL,
    bytes: [
      "{",
      '  "type": "authorized_user",',
      '  "client_id": "1234567890-conformance.apps.googleusercontent.com",',
      '  "client_secret": "conformance-client-secret",',
      '  "refresh_token": "conformance-refresh-token",',
      '  "document_id": "conformance-document-id"',
      "}",
      "",
    ].join("\n"),
  }),
  withFolder: Object.freeze({
    credentials: WITH_FOLDER,
    bytes: [
      "{",
      '  "type": "authorized_user",',
      '  "client_id": "1234567890-conformance.apps.googleusercontent.com",',
      '  "client_secret": "conformance-client-secret",',
      '  "refresh_token": "conformance-refresh-token",',
      '  "document_id": "conformance-document-id",',
      '  "folder_id": "conformance-folder-id"',
      "}",
      "",
    ].join("\n"),
  }),
  withoutTarget: Object.freeze({
    credentials: WITHOUT_TARGET,
    bytes: [
      "{",
      '  "type": "authorized_user",',
      '  "client_id": "1234567890-conformance.apps.googleusercontent.com",',
      '  "client_secret": "conformance-client-secret",',
      '  "refresh_token": "conformance-refresh-token"',
      "}",
      "",
    ].join("\n"),
  }),
});

/* Assertion helpers. Deliberately dependency-free so no assertion library — and in
 * particular no test runner — leaks into shipped code. */

function fail(message: string): never {
  throw new Error(`Google credentials conformance: ${message}`);
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
  createHarness: CredentialsHarnessFactory,
  body: (harness: CredentialsWriterHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await body(harness);
  } finally {
    await harness.dispose?.();
  }
}

async function directoryEntries(path: string): Promise<readonly string[]> {
  return [...await readdir(dirname(path))].sort();
}

/**
 * Asserts the writer's directory holds the credentials file and NOTHING else.
 *
 * Closed rather than open: see CredentialsWriterHarness for why the harness owes an empty
 * directory, and for what this costs a writer that keeps sibling files.
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
 * cross-repository contract can have. A Rust writer on Windows reports
 * `C:/Users/.../google-credentials.json` with forward slashes; a path assembled from
 * components carries `..` hops; macOS's temp root is a symlink (`/var` -> `/private/var`).
 * All three name core's file and none of them match it character for character.
 *
 * Three widening steps, cheapest first. `resolve` settles separators and `..`. `realpath`
 * settles symlinks, and on Windows also drive-letter case. Device+inode is the last
 * resort, and is skipped when the inode is 0 — Windows reports that for files whose index
 * it cannot supply, and two zeroes are not evidence of anything.
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

export const GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS: readonly CredentialsConformanceScenario[] = [
  {
    name: "writes to core's own credentialsPath(), not a re-derived one",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The scenario that stops a writer re-deriving the platform config directory and
      // drifting from core's. Core owns that resolution; a writer satisfies it.
      //
      // Against core's own reference harness this scenario is vacuous — that harness calls
      // credentialsPath() to decide where to write, so this compares the function to
      // itself. It earns its keep against the two callers that matter: the wrong-path
      // mutation in core's own mutation sweep, and a real external writer that computed
      // the path in another language.
      //
      // Compared as a LOCATION, not as a string. Windows is exactly where path spelling
      // diverges between languages, and a contract that rejects a correct Rust writer for
      // reporting forward slashes is worse than no contract.
      const { credentialsPath } = await import("../google/file-token-provider.js");
      const reported = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const expected = credentialsPath();
      check(
        await sameFile(reported, expected),
        `reported write path ${JSON.stringify(reported)} is not core's credentialsPath() ${JSON.stringify(expected)}`,
      );
    }),
  },
  {
    name: "core can read the file back with every field intact",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      const { readCredentials } = await import("../google/file-token-provider.js");
      const fixture = GOOGLE_CREDENTIALS_FIXTURES.withFolder.credentials;
      const result = await readCredentials(await write(fixture));
      if (!result.ok) fail(`core rejected the written file: ${result.message}`);
      for (const [key, expected] of Object.entries(fixture)) {
        assertEqual((result.value as Record<string, unknown>)[key], expected, `field ${key}`);
      }

      // A credential with no target must still READ. document_id is optional: nothing in
      // core reads it off this file, so requiring it would only make a usable credential
      // unreadable — and it would force whoever performs consent to obtain a target in the
      // same step, foreclosing a "connect now, choose the target next" flow.
      const { document_id: _target, ...withoutTarget } = fixture;
      const noTarget = await readCredentials(await write(withoutTarget));
      if (!noTarget.ok) fail(`core rejected a credential with no document_id: ${noTarget.message}`);
    }),
  },
  {
    name: 'the type discriminator is exactly "authorized_user"',
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      const path = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      assertEqual(parsed.type, "authorized_user", "type");
    }),
  },
  {
    name: "google-auth-library's own ADC loader accepts the file",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The scenario that actually pins ADC alignment. Everything else here could pass
      // against a home-grown format that merely looks similar.
      const { UserRefreshClient } = await import("google-auth-library");
      const path = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      UserRefreshClient.fromJSON(parsed);
    }),
  },
  {
    name: "the file is mode 0600",
    requires: "posixPermissions",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      const path = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      assertEqual((await stat(path)).mode & 0o777, 0o600, "file mode");
    }),
  },
  {
    name: "an overwrite is wholesale: a field the second write omits is gone",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // Pins the deletion of the merge. A writer that helpfully preserves fields has
      // reintroduced a merge protocol, which is where the silent data loss lived.
      await write(GOOGLE_CREDENTIALS_FIXTURES.withFolder.credentials);
      const path = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      check(!("folder_id" in parsed), "folder_id survived an overwrite that omitted it");
    }),
  },
  {
    name: "a write leaves no temp-file debris behind",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The observable half of the write-then-rename requirement — and only that half:
      // atomicity itself is invisible from out here, see the note at the top of this file.
      // Core no longer controls the writer and reads this file during a live capture, so a
      // torn read is indistinguishable from a corrupt one.
      //
      // Checked TWICE, because each catches a different writer. After the FIRST write:
      // a writer that dies between write and rename does so on whichever run it crashes,
      // including the first, on a fresh machine — the realistic failure — and a baseline
      // taken after that write already contains the debris. After the SECOND: a writer
      // that cleans up on some paths but not others, or whose sibling files only appear
      // once it has something to compare against.
      //
      // EXACT listing, not a name-shape guess. This is what catches `.tmpAb3XyZ` — Rust
      // `tempfile`'s default NamedTempFile name, matching no temp-name pattern anyone
      // thought to write down — along with every other convention nobody anticipated. It
      // rests entirely on the harness handing over an empty, writer-owned directory.
      const first = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const target = basename(first);
      assertOnlyEntry(await directoryEntries(first), target, "after the first write");

      await write(GOOGLE_CREDENTIALS_FIXTURES.withFolder.credentials);
      assertOnlyEntry(await directoryEntries(first), target, "after a second write");
    }),
  },
  {
    name: "the bytes match the golden fixture exactly",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // Extra top-level keys fail here even though core's reader tolerates them at
      // runtime; the fixture doc gives the reason, and it is a coordinated change.
      //
      // Ordered so each fixture is a SUPERSET of the one before. A writer that merges
      // instead of overwriting is already caught, precisely and alone, by the overwrite
      // scenario; run in the other order it would fail this scenario too, and a second
      // failure that says nothing about serialisation makes the report harder to read.
      const { minimal, withFolder, withoutTarget } = GOOGLE_CREDENTIALS_FIXTURES;
      for (const golden of [withoutTarget, minimal, withFolder]) {
        const path = await write(golden.credentials);
        assertEqual(await readFile(path, "utf8"), golden.bytes, "file bytes");
      }
    }),
  },
];

/**
 * Register every scenario with a caller-supplied runner. Scenarios whose capability the
 * platform does not declare are reported as `todo` when the runner supports it, so an
 * unrun scenario is visible rather than silently absent.
 */
export function describeGoogleCredentialsConformance(
  primitives: ConformanceTestPrimitives,
  name: string,
  createHarness: CredentialsHarnessFactory,
  support: CredentialsConformanceSupport = {},
): void {
  const { describe, test } = primitives;
  describe(`Google credentials conformance: ${name}`, () => {
    for (const scenario of GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS) {
      if (scenario.requires !== undefined && support[scenario.requires] !== true) {
        if (test.todo !== undefined) test.todo(scenario.name, () => {});
        continue;
      }
      test(scenario.name, () => scenario.run(createHarness));
    }
  });
}
