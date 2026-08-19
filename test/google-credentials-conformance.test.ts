import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS,
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
 * This is also how core's harnesses satisfy the empty-directory precondition
 * CredentialsWriterHarness states: a fresh mkdtemp per harness, so the config directory
 * under it does not exist until the writer creates it and holds nothing the writer did
 * not put there. An external harness owes the same guarantee by whatever means its
 * writer locates the config directory.
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

  test("a writer that dies before its first rename, leaving tempfile's own default name, fails the debris scenario", async () => {
    // The mutation the whole rewrite exists for. `.tmpAb3XyZ` is what Rust's `tempfile`
    // crate names a NamedTempFile by default — prefix `.tmp`, random characters, no
    // extension — so it is what `NamedTempFile::new_in` and `atomicwrites` leave behind
    // when the process dies between write and rename. It matched NONE of the name shapes
    // an earlier debris scenario looked for, and a writer leaving it on its FIRST write
    // passed the entire suite.
    //
    // First write only, and per-harness state, because that is the realistic failure: a
    // fresh machine, one crash, debris that never appears again. A before/after comparison
    // across a second write takes its baseline with the debris already in it.
    const failures = await failingScenarios(
      async () => {
        const scope = await withScratchConfigDirectory();
        let firstWrite = true;
        return {
          write: async (credentials: CredentialsFixture) => {
            const path = credentialsPath();
            if (firstWrite) {
              firstWrite = false;
              await plainWrite(join(dirname(path), ".tmpAb3XyZ"), "leftover");
            }
            return plainWrite(path, serializeCredentials(credentials));
          },
          dispose: async () => { scope.restore(); },
        };
      },
      support,
    );
    expect(failures).toEqual([DEBRIS_SCENARIO]);
  });

  test("a writer that keeps a sibling file of its own fails the debris scenario", async () => {
    // Pins the half of the contract that says the scratch directory belongs to the writer
    // alone. The sibling is written EVERY time, so it is in the baseline listing as well as
    // the later ones — a before/after comparison never sees it, and no name-shape rule
    // would call `last-sync.json` suspicious. Only an exact listing catches it.
    const failures = await failingScenarios(
      brokenHarness(async (path, credentials) => {
        const written = await plainWrite(path, serializeCredentials(credentials));
        await plainWrite(join(dirname(path), "last-sync.json"), "{}\n");
        return written;
      }),
      support,
    );
    expect(failures).toEqual([DEBRIS_SCENARIO]);
  });

  test("a correct writer reporting the same path spelled differently passes every scenario", async () => {
    // Not a wrong writer at all — the regression guard for the worst failure mode a
    // cross-repo contract can have: rejecting a CORRECT implementation. A Rust writer on
    // Windows reports `C:/Users/.../google-credentials.json` with forward slashes, and a
    // path assembled from components carries `..` hops. Both name the same file.
    const failures = await failingScenarios(
      brokenHarness(async (path, credentials) => {
        await plainWrite(path, serializeCredentials(credentials));
        const directory = dirname(path);
        // Built by concatenation, not join(): join() would normalise the `..` away and the
        // mutation would test nothing.
        return `${directory}/../${basename(directory)}/${basename(path)}`.replace(/\\/g, "/");
      }),
      support,
    );
    expect(failures).toEqual([]);
  });

  test("a writer emitting null for an absent document_id fails the byte scenario", async () => {
    // serde's `Option<String>` without `#[serde(skip_serializing_if = "Option::is_none")]`:
    // absent becomes `null`, not absent. The rule is "omit, never null", and until a golden
    // fixture carried NO document_id nothing pinned it — every fixture had one, so this
    // writer produced byte-perfect files and passed the whole suite.
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { document_id: documentId, folder_id: folderId, ...adc } = credentials;
        return plainWrite(path, `${JSON.stringify({
          ...adc, document_id: documentId ?? null, ...(folderId === undefined ? {} : { folder_id: folderId }),
        }, null, 2)}\n`);
      }),
      support,
    );
    expect(failures).toEqual([BYTES_SCENARIO]);
  });

  test("a writer that leaves its temp file behind fails the debris scenario", async () => {
    // The obvious case: an unmistakably temp-shaped name, left on every write. Kept
    // alongside the `.tmpAb3XyZ` mutation above because the two fail for different
    // reasons — this one would be caught by any rule at all, that one only by an exact
    // listing, and a contract that catches only this one is the contract we just fixed.
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
