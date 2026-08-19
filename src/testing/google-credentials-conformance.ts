import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
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

export type CredentialsWriterHarness = Readonly<{
  /** Write these credentials wherever the implementation writes them, and report the path. */
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
 * Both fixtures below carry a document_id, so their bytes do not depend on that rule —
 * the omission is pinned by the reader's own tests instead.
 */
export const GOOGLE_CREDENTIALS_FIXTURES: Readonly<{
  minimal: CredentialsGoldenFixture;
  withFolder: CredentialsGoldenFixture;
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
 * Whether a directory entry looks like an unfinished write rather than a settled file.
 *
 * Deliberately a name shape rather than "anything that is not the target": the
 * credentials file's directory is the shared Shorthand config directory and may hold
 * other legitimate files, so a strict "nothing else may exist" check would fail an
 * honest writer on a real machine.
 */
function looksTemporary(entry: string, target: string): boolean {
  if (entry === target) return false;
  return /\.(tmp|temp|partial|swp)$/i.test(entry)
    || entry.startsWith(`.${target}`)
    || entry.startsWith(`${target}.`);
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
      const { credentialsPath } = await import("../google/file-token-provider.js");
      assertEqual(await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials), credentialsPath(), "reported write path");
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
      // The observable half of the write-then-rename requirement. Core no longer controls
      // the writer and reads this file during a live capture, so a torn read is
      // indistinguishable from a corrupt one.
      //
      // TWO checks, because either alone is blind. The FIRST write's own listing is
      // checked for temp-shaped names: a baseline taken after that write already contains
      // whatever the first write left behind, so a writer that dies between write and
      // rename on a fresh machine — the realistic Rust failure — would pass a
      // before/after comparison. And the second write is then compared against the first
      // write's listing, which is what catches a writer whose temp name varies per call
      // and so never leaves the same entry twice.
      const first = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const target = basename(first);
      const before = await directoryEntries(first);
      check(before.includes(target), "the credentials file is not in its own directory listing");
      const strays = before.filter((entry) => looksTemporary(entry, target));
      check(strays.length === 0, `the first write left temp-file debris: ${JSON.stringify(strays)}`);

      await write(GOOGLE_CREDENTIALS_FIXTURES.withFolder.credentials);
      const after = await directoryEntries(first);
      check(
        after.length === before.length && after.every((entry, index) => entry === before[index]),
        `a write added or left entries in the directory: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
      );
    }),
  },
  {
    name: "the bytes match the golden fixture exactly",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      for (const golden of [GOOGLE_CREDENTIALS_FIXTURES.minimal, GOOGLE_CREDENTIALS_FIXTURES.withFolder]) {
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
