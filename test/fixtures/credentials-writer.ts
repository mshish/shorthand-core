import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialsFixture } from "../../src/testing/google-credentials-conformance.js";

/**
 * A deliberately correct writer of the Google credentials file, for core's own tests.
 *
 * It lives under test/ and not under src/ on purpose: core is a pure reader, and nothing
 * it ships may write this file. This exists only so core's conformance scenarios have
 * something to run against — a suite that has never been run at all is not evidence of
 * anything, and one that has only ever been run green is barely more.
 */
export const CREDENTIALS_KEY_ORDER = [
  "type", "client_id", "client_secret", "refresh_token", "document_id", "folder_id",
] as const;

export function serializeCredentials(credentials: CredentialsFixture): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CREDENTIALS_KEY_ORDER) {
    const value = (credentials as Record<string, unknown>)[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writeCredentialsFile(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  // Same-directory temp then rename: a cross-filesystem rename is not atomic, and core
  // reads this file during a live capture where a torn read looks like a corrupt one.
  const temporary = join(dirname(path), `.google-credentials.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, body, "utf8");
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
  return path;
}
