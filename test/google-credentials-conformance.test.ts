import { afterEach, describe, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeGoogleCredentialsConformance } from "shorthand-core/testing";
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
