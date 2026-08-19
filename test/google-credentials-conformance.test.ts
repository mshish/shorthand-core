import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS,
  GOOGLE_CREDENTIALS_FIXTURES,
  describeGoogleCredentialsConformance,
} from "shorthand-core/testing";
import type { CredentialsFixture, CredentialsWriterHarness } from "shorthand-core/testing";
import { credentialsPath } from "../src/google/file-token-provider.js";
import { serializeCredentials, writeCredentialsFile } from "./fixtures/credentials-writer.js";

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Points every environment variable shorthandConfigDirectory() consults at a scratch
 * directory, so credentialsPath() resolves inside it on every platform, and restores
 * them afterwards. The path scenario compares against credentialsPath() with the real
 * process.env, so there is no way to run it without redirecting the real one.
 *
 * This mutates GLOBAL process.env, and it is safe for exactly one reason: `bun test` runs
 * test FILES one at a time, so no other file observes the window in which HOME and APPDATA
 * point at a temp directory. A parallel test runner would turn this into a heisenbug in
 * whichever file happened to read the config directory at the wrong moment —
 * test/config.test.ts first among them. If this suite is ever run concurrently, this
 * helper has to be replaced by passing an explicit environment into credentialsPath(),
 * which already accepts one.
 */
export async function withScratchConfigDirectory(): Promise<{ restore(): void }> {
  const scratch = await mkdtemp(join(tmpdir(), "google-credentials-conformance-"));
  scratchDirectories.push(scratch);
  const keys = ["APPDATA", "XDG_CONFIG_HOME", "HOME", "USERPROFILE"] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = scratch;
  return {
    restore: () => {
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

export async function createCorrectHarness(): Promise<CredentialsWriterHarness> {
  const scope = await withScratchConfigDirectory();
  return {
    write: (credentials: CredentialsFixture) =>
      writeCredentialsFile(credentialsPath(), serializeCredentials(credentials)),
    dispose: async () => { scope.restore(); },
  };
}

describeGoogleCredentialsConformance(
  { describe, test },
  "the reference writer",
  createCorrectHarness,
  { posixPermissions: process.platform !== "win32" },
);

/** Runs every scenario and returns the names of the ones that threw. */
async function failingScenarios(
  createHarness: () => Promise<CredentialsWriterHarness>,
  support: { posixPermissions: boolean },
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const scenario of GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS) {
    if (scenario.requires !== undefined && !support[scenario.requires]) continue;
    try {
      await scenario.run(createHarness);
    } catch {
      failures.push(scenario.name);
    }
  }
  return failures.sort();
}

const PATH_SCENARIO = "writes to core's own credentialsPath(), not a re-derived one";
const READ_SCENARIO = "core can read the file back with every field intact";
const TYPE_SCENARIO = 'the type discriminator is exactly "authorized_user"';
const LOADER_SCENARIO = "google-auth-library's own ADC loader accepts the file";
const MODE_SCENARIO = "the file is mode 0600";
const OVERWRITE_SCENARIO = "an overwrite is wholesale: a field the second write omits is gone";
const DEBRIS_SCENARIO = "a write leaves no temp-file debris behind";
const BYTES_SCENARIO = "the bytes match the golden fixture exactly";

/** Builds a harness whose write() is deliberately broken in one specific way. */
function brokenHarness(
  brokenWrite: (path: string, credentials: CredentialsFixture) => Promise<string>,
): () => Promise<CredentialsWriterHarness> {
  return async () => {
    const scope = await withScratchConfigDirectory();
    return {
      write: (credentials: CredentialsFixture) => brokenWrite(credentialsPath(), credentials),
      dispose: async () => { scope.restore(); },
    };
  };
}

async function plainWrite(path: string, body: string, mode = 0o600): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  if (process.platform !== "win32") await chmod(path, mode);
  return path;
}

describe("the credentials conformance suite detects a wrong writer", () => {
  const support = { posixPermissions: process.platform !== "win32" };

  test("a writer that picks its own path fails the path scenario", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) =>
        plainWrite(join(dirname(path), "elsewhere.json"), serializeCredentials(credentials))),
      support,
    );
    expect(failures).toEqual([PATH_SCENARIO]);
  });

  test("a writer using camelCase for our two fields fails the read-back and byte scenarios", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { document_id: documentId, folder_id: folderId, ...adc } = credentials;
        return plainWrite(path, `${JSON.stringify({
          ...adc, documentId, ...(folderId === undefined ? {} : { folderId }),
        }, null, 2)}\n`);
      }),
      support,
    );
    // The ADC half is still correct, so Google's loader still accepts it — which is
    // exactly why the read-back scenario has to exist separately from the loader one.
    expect(failures).toEqual([READ_SCENARIO, BYTES_SCENARIO].sort());
  });

  test("a writer that omits type fails the type, read-back, loader and byte scenarios", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { type: _type, ...rest } = credentials;
        return plainWrite(path, `${JSON.stringify(rest, null, 2)}\n`);
      }),
      support,
    );
    expect(failures).toEqual([TYPE_SCENARIO, READ_SCENARIO, LOADER_SCENARIO, BYTES_SCENARIO].sort());
  });

  test.skipIf(process.platform === "win32")("a writer using mode 0644 fails only the permissions scenario", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => plainWrite(path, serializeCredentials(credentials), 0o644)),
      support,
    );
    expect(failures).toEqual([MODE_SCENARIO]);
  });

  test("a writer that preserves folder_id across an overwrite fails the overwrite scenario", async () => {
    // The anti-merge scenario. This is the mutation that proves deleting mergeCredentials
    // is enforced rather than merely intended.
    //
    // `previous` is declared INSIDE the factory, so every scenario in the sweep gets a
    // fresh merging writer. Hoisted outside it, one `previous` accumulates across all
    // eight scenarios: by the time the golden-bytes scenario runs it still carries the
    // folder_id an earlier scenario wrote, so the bytes fail too and the expected set
    // becomes [BYTES, OVERWRITE] — a second failure that says nothing about the merge.
    // This is not hypothetical; it is what the first draft of this test did.
    //
    // brokenHarness() is deliberately not used here: it takes a write function, and this
    // mutation needs per-harness state, which only a factory can hold.
    const failures = await failingScenarios(
      async () => {
        const scope = await withScratchConfigDirectory();
        let previous: Record<string, unknown> = {};
        return {
          write: (credentials: CredentialsFixture) => {
            previous = { ...previous, ...credentials };
            return plainWrite(credentialsPath(), serializeCredentials(previous as CredentialsFixture));
          },
          dispose: async () => { scope.restore(); },
        };
      },
      support,
    );
    expect(failures).toEqual([OVERWRITE_SCENARIO]);
  });

  test("a writer that leaves its temp file behind fails the debris scenario", async () => {
    // A FIXED temp name on purpose, and the debris scenario must catch it on the FIRST
    // write: a writer that dies between write and rename does so on whichever run it
    // crashes, including the first, and a scenario that only compares before/after across
    // a second write is blind to that — it would take its baseline with the debris already
    // in it. Task 8's scenario checks the first write's own listing for temp-shaped names
    // for exactly this reason.
    const failures = await failingScenarios(
      brokenHarness(async (path, credentials) => {
        await plainWrite(join(dirname(path), ".google-credentials.tmp"), "leftover");
        return plainWrite(path, serializeCredentials(credentials));
      }),
      support,
    );
    expect(failures).toEqual([DEBRIS_SCENARIO]);
  });
});
