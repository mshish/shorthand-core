import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  LLM_CREDENTIALS_CONFORMANCE_SCENARIOS,
  describeLlmCredentialsConformance,
} from "shorthand-core/testing";
import type { LlmCredentialsFixture, LlmCredentialsWriterHarness } from "shorthand-core/testing";
import { llmCredentialsPath } from "../src/agent/llm-credentials.js";

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Points every environment variable shorthandConfigDirectory() consults at a scratch
 * directory, so llmCredentialsPath() resolves inside it on every platform, and restores
 * them afterwards. The path scenario compares against llmCredentialsPath() with the real
 * process.env, so there is no way to run it without redirecting the real one.
 *
 * This is also how these harnesses satisfy the empty-directory precondition
 * LlmCredentialsWriterHarness states: a fresh mkdtemp per harness, so the config directory
 * under it does not exist until the writer creates it and holds nothing the writer did not
 * put there. An external harness owes the same guarantee by whatever means its writer
 * locates the config directory.
 *
 * This mutates GLOBAL process.env, and it is safe for exactly one reason: `bun test` runs
 * test FILES one at a time, so no other file observes the window in which HOME and APPDATA
 * point at a temp directory. A parallel runner would turn this into a heisenbug in
 * whichever file happened to read the config directory at the wrong moment. If this suite
 * is ever run concurrently, this helper has to be replaced by passing an explicit
 * environment into llmCredentialsPath(), which already accepts one.
 */
async function withScratchConfigDirectory(): Promise<{ restore(): void }> {
  const scratch = await mkdtemp(join(tmpdir(), "llm-credentials-conformance-"));
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

/**
 * A deliberately correct writer of the LLM credentials file, for core's own tests.
 *
 * It lives under test/ and not under src/ on purpose: core is a pure reader of this file
 * and nothing it ships may write it. This exists only so the conformance scenarios have
 * something to run against — a suite that has never been run at all is not evidence of
 * anything, and one that has only ever been run green is barely more.
 */
const LLM_CREDENTIALS_KEY_ORDER = ["provider", "model", "api_key", "base_url"] as const;

function serializeLlmCredentials(credentials: LlmCredentialsFixture): string {
  const ordered: Record<string, unknown> = {};
  for (const key of LLM_CREDENTIALS_KEY_ORDER) {
    const value = (credentials as Record<string, unknown>)[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

async function plainWrite(path: string, body: string, mode = 0o600): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  if (process.platform !== "win32") await chmod(path, mode);
  return path;
}

async function writeLlmCredentialsFile(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  // Same-directory temp then rename: a cross-filesystem rename is not atomic, and a reader
  // that catches this file mid-write cannot tell a torn read from a corrupt one.
  const temporary = join(dirname(path), `.llm-credentials.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, body, "utf8");
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
  return path;
}

async function createCorrectHarness(): Promise<LlmCredentialsWriterHarness> {
  const scope = await withScratchConfigDirectory();
  return {
    write: (credentials) =>
      writeLlmCredentialsFile(llmCredentialsPath(), serializeLlmCredentials(credentials)),
    dispose: async () => { scope.restore(); },
  };
}

describeLlmCredentialsConformance(
  { describe, test },
  "the reference writer",
  createCorrectHarness,
  { posixPermissions: process.platform !== "win32" },
);

/** Runs every scenario and returns the names of the ones that threw. */
async function failingScenarios(
  createHarness: () => Promise<LlmCredentialsWriterHarness>,
  support: { posixPermissions: boolean },
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const scenario of LLM_CREDENTIALS_CONFORMANCE_SCENARIOS) {
    if (scenario.requires !== undefined && !support[scenario.requires]) continue;
    try {
      await scenario.run(createHarness);
    } catch {
      failures.push(scenario.name);
    }
  }
  return failures.sort();
}

const PATH_SCENARIO = "writes to core's own llmCredentialsPath(), not a re-derived one";
const READ_SCENARIO = "core can read the file back with every field intact";
const ROUND_TRIP_SCENARIO = "every provider variant round-trips, including a keyless openai-compatible";
const OVERWRITE_SCENARIO = "an overwrite is wholesale: a key the second write omits is gone";
const DEBRIS_SCENARIO = "a write leaves no temp-file debris behind";
const MODE_SCENARIO = "the file is mode 0600";
const BYTES_SCENARIO = "the bytes match the golden fixture exactly";

/** Builds a harness whose write() is deliberately broken in one specific way. */
function brokenHarness(
  brokenWrite: (path: string, credentials: LlmCredentialsFixture) => Promise<string>,
): () => Promise<LlmCredentialsWriterHarness> {
  return async () => {
    const scope = await withScratchConfigDirectory();
    return {
      write: (credentials: LlmCredentialsFixture) => brokenWrite(llmCredentialsPath(), credentials),
      dispose: async () => { scope.restore(); },
    };
  };
}

/**
 * The half of this file that gives the suite its meaning.
 *
 * A conformance suite that has only ever been pointed at a correct writer has not been
 * shown to fail an incorrect one, and the plugin's writer is going to be held to this. Each
 * test below breaks exactly one requirement and asserts the EXACT set of scenarios that
 * notices — exact, not "at least", because a suite whose scenarios all fail together
 * localises nothing, and because a false failure against a correct writer is the worst
 * outcome a cross-repository contract can have.
 */
describe("the LLM credentials conformance suite detects a wrong writer", () => {
  const support = { posixPermissions: process.platform !== "win32" };

  test("a writer that picks its own file name fails the path scenario", async () => {
    // `llm.json` in the right directory: core never looks there, and every other scenario
    // is satisfied because they all follow the path the writer reported.
    const failures = await failingScenarios(
      brokenHarness((path, credentials) =>
        plainWrite(join(dirname(path), "llm.json"), serializeLlmCredentials(credentials))),
      support,
    );
    expect(failures).toEqual([PATH_SCENARIO]);
  });

  test("a writer using camelCase for api_key fails the read-back, round-trip and byte scenarios", async () => {
    // The likeliest real bug in a TypeScript writer: the field is apiKey everywhere in its
    // own code and gets serialised as it stands. The file still parses, still names a
    // provider and a model, and still has an endpoint — core just silently has no key.
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { api_key: apiKey, base_url: baseUrl, ...head } = credentials;
        const body: Record<string, unknown> = { ...head };
        if (apiKey !== undefined) body.apiKey = apiKey;
        if (baseUrl !== undefined) body.base_url = baseUrl;
        return plainWrite(path, `${JSON.stringify(body, null, 2)}\n`);
      }),
      support,
    );
    expect(failures).toEqual([READ_SCENARIO, ROUND_TRIP_SCENARIO, BYTES_SCENARIO].sort());
  });

  test("a writer emitting null for an absent api_key fails only the byte scenario", async () => {
    // serde's `Option<String>` without `#[serde(skip_serializing_if = "Option::is_none")]`:
    // absent becomes null, not absent. Core's READER tolerates it — that tolerance is
    // deliberate and stays — so nothing but the golden bytes can catch this, and nothing
    // would have caught it at all while every fixture carried an api_key.
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { api_key: apiKey, base_url: baseUrl, ...head } = credentials;
        const body: Record<string, unknown> = { ...head, api_key: apiKey ?? null };
        if (baseUrl !== undefined) body.base_url = baseUrl;
        return plainWrite(path, `${JSON.stringify(body, null, 2)}\n`);
      }),
      support,
    );
    expect(failures).toEqual([BYTES_SCENARIO]);
  });

  test('a writer clearing a key to "" rather than omitting it fails only the byte scenario', async () => {
    // The other spelling of the same mistake, and the reason the byte scenario has to be
    // stricter than the reader: "cleared" must have ONE representation on disk, or two
    // writers agree with core and disagree with each other.
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { api_key: apiKey, base_url: baseUrl, ...head } = credentials;
        const body: Record<string, unknown> = { ...head, api_key: apiKey ?? "" };
        if (baseUrl !== undefined) body.base_url = baseUrl;
        return plainWrite(path, `${JSON.stringify(body, null, 2)}\n`);
      }),
      support,
    );
    expect(failures).toEqual([BYTES_SCENARIO]);
  });

  test("a writer emitting the keys in alphabetical order fails only the byte scenario", async () => {
    // What a writer built on an ordered map, or on a language whose struct order is not the
    // one this contract fixes, produces. Semantically identical, byte-wise not — which is
    // exactly what a golden-byte contract is for, since the writer's own repository is
    // expected to assert against those bytes with no JavaScript in the loop.
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const ordered: Record<string, unknown> = {};
        for (const key of Object.keys(credentials).sort()) {
          ordered[key] = (credentials as Record<string, unknown>)[key];
        }
        return plainWrite(path, `${JSON.stringify(ordered, null, 2)}\n`);
      }),
      support,
    );
    expect(failures).toEqual([BYTES_SCENARIO]);
  });

  test("a writer that persists base_url only alongside a key fails the round-trip, overwrite and byte scenarios", async () => {
    // The mutation the keyless openai-compatible fixture exists for. Treating the key and
    // the endpoint as one credential pair is a natural reading of "credentials", and it
    // breaks precisely the profile that has an endpoint and no key — a local Ollama —
    // producing a file core's reader rejects outright. Every keyed provider still passes,
    // so without that fixture this writer would look conformant.
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { base_url: baseUrl, ...head } = credentials;
        const endpoint = credentials.api_key !== undefined && baseUrl !== undefined
          ? { base_url: baseUrl }
          : {};
        return plainWrite(path, `${JSON.stringify({ ...head, ...endpoint }, null, 2)}\n`);
      }),
      support,
    );
    // The overwrite scenario fails as collateral rather than on its own account: its second
    // write is the keyless openai-compatible profile, which this writer renders unreadable,
    // so the question "did the old api_key survive" cannot be answered at all.
    expect(failures).toEqual([ROUND_TRIP_SCENARIO, OVERWRITE_SCENARIO, BYTES_SCENARIO].sort());
  });

  test("a writer that preserves api_key across an overwrite fails the overwrite scenario", async () => {
    // The anti-merge mutation, and the one that matters most in this file: a stale key that
    // outlives the key the user cleared keeps billing them, and does it silently.
    //
    // `previous` is declared INSIDE the factory so every scenario in the sweep gets a fresh
    // merging writer; hoisted out, one accumulating `previous` would leak a key from an
    // earlier scenario into the byte comparison and add a failure that says nothing about
    // merging. brokenHarness() is deliberately not used: it takes a write function, and
    // this mutation needs per-harness state, which only a factory can hold.
    const failures = await failingScenarios(
      async () => {
        const scope = await withScratchConfigDirectory();
        let previous: Record<string, unknown> = {};
        return {
          write: (credentials: LlmCredentialsFixture) => {
            previous = { ...previous, ...credentials };
            return plainWrite(
              llmCredentialsPath(),
              serializeLlmCredentials(previous as LlmCredentialsFixture),
            );
          },
          dispose: async () => { scope.restore(); },
        };
      },
      support,
    );
    expect(failures).toEqual([OVERWRITE_SCENARIO]);
  });

  test("a writer that dies before its first rename, leaving tempfile's own default name, fails the debris scenario", async () => {
    // `.tmpAb3XyZ` is what Rust's `tempfile` crate names a NamedTempFile by default —
    // prefix `.tmp`, random characters, no extension — so it is what `NamedTempFile::new_in`
    // and `atomicwrites` leave behind when the process dies between write and rename. It
    // matches no temp-name pattern anyone thinks to write down.
    //
    // First write only, and per-harness state, because that is the realistic failure: a
    // fresh machine, one crash, debris that never appears again. A before/after comparison
    // across a second write takes its baseline with the debris already in it.
    const failures = await failingScenarios(
      async () => {
        const scope = await withScratchConfigDirectory();
        let firstWrite = true;
        return {
          write: async (credentials: LlmCredentialsFixture) => {
            const path = llmCredentialsPath();
            if (firstWrite) {
              firstWrite = false;
              await plainWrite(join(dirname(path), ".tmpAb3XyZ"), "leftover");
            }
            return plainWrite(path, serializeLlmCredentials(credentials));
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
    // the later ones — a before/after comparison never sees it, and no name-shape rule would
    // call `last-sync.json` suspicious. Only an exact listing catches it.
    const failures = await failingScenarios(
      brokenHarness(async (path, credentials) => {
        const written = await plainWrite(path, serializeLlmCredentials(credentials));
        await plainWrite(join(dirname(path), "last-sync.json"), "{}\n");
        return written;
      }),
      support,
    );
    expect(failures).toEqual([DEBRIS_SCENARIO]);
  });

  test.skipIf(process.platform === "win32")("a writer using mode 0644 fails only the permissions scenario", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => plainWrite(path, serializeLlmCredentials(credentials), 0o644)),
      support,
    );
    expect(failures).toEqual([MODE_SCENARIO]);
  });

  test("a correct writer reporting the same path spelled differently passes every scenario", async () => {
    // Not a wrong writer at all — the regression guard for the worst failure mode a
    // cross-repo contract can have: rejecting a CORRECT implementation. A writer on Windows
    // reports `C:/Users/.../llm-credentials.json` with forward slashes, and a path assembled
    // from components carries `..` hops. Both name the same file.
    const failures = await failingScenarios(
      brokenHarness(async (path, credentials) => {
        await plainWrite(path, serializeLlmCredentials(credentials));
        const directory = dirname(path);
        // Built by concatenation, not join(): join() would normalise the `..` away and the
        // mutation would test nothing.
        return `${directory}/../${basename(directory)}/${basename(path)}`.replace(/\\/g, "/");
      }),
      support,
    );
    expect(failures).toEqual([]);
  });
});
