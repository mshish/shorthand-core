import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileTokenProvider, readCredentials } from "../src/google/file-token-provider.js";
import type { GoogleCredentials } from "../src/google/file-token-provider.js";

const VALID: GoogleCredentials = {
  type: "authorized_user",
  client_id: "1234567890-test.apps.googleusercontent.com",
  client_secret: "test-client-secret",
  refresh_token: "rt-1",
  document_id: "doc-1",
};

async function scratchPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "google-token-"));
  return join(directory, "google-credentials.json");
}

/** Test-only writer. Core is a pure reader; nothing under src/ writes this file. */
async function writeRaw(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o600);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  return writeRaw(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("readCredentials", () => {
  test("reads back every field of a well-formed file", async () => {
    const path = await writeJson(await scratchPath(), { ...VALID, folder_id: "folder-1" });
    expect(await readCredentials(path)).toEqual({
      ok: true,
      value: { ...VALID, folder_id: "folder-1" },
    });
    await rm(path, { force: true });
  });

  test("omits folder_id entirely when the file has none", async () => {
    const result = await readCredentials(await writeJson(await scratchPath(), VALID));
    expect(result.ok).toBe(true);
    if (result.ok) expect("folder_id" in result.value).toBe(false);
  });

  test("a credential with no document_id reads successfully, with the key omitted", async () => {
    // Decided by the human: a missing target does not make a credential unreadable.
    // Nothing in core reads document_id off this file — GoogleDocsNoteSink takes
    // documentId as a constructor option — so rejecting the file would serve no consumer,
    // and it would foreclose a "connect now, choose the target next" step in whatever
    // performs consent.
    const partial: Record<string, unknown> = { ...VALID };
    delete partial.document_id;
    const result = await readCredentials(await writeJson(await scratchPath(), partial));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("document_id" in result.value).toBe(false);
      expect(result.value.refresh_token).toBe("rt-1");
    }
  });

  test("ignores unknown top-level keys instead of rejecting them", async () => {
    // Forward compatibility: a newer writer adding a field must not break an older core.
    const path = await writeJson(await scratchPath(), { ...VALID, quota_project_id: "p", future_field: 7 });
    expect(await readCredentials(path)).toEqual({ ok: true, value: VALID });
  });

  test("reports an absent file without throwing", async () => {
    const result = await readCredentials(await scratchPath());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("No Google credentials at");
  });

  test("reports non-JSON bytes without throwing", async () => {
    const result = await readCredentials(await writeRaw(await scratchPath(), "not json at all"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not valid JSON");
  });

  test("reports a JSON value that is not an object without throwing", async () => {
    const result = await readCredentials(await writeRaw(await scratchPath(), "[1,2,3]"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not a JSON object");
  });

  test("rejects a wrong type discriminator by name", async () => {
    const path = await writeJson(await scratchPath(), { ...VALID, type: "service_account" });
    const result = await readCredentials(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("authorized_user");
  });

  test.each(["client_id", "client_secret", "refresh_token"] as const)(
    "names the missing required ADC field %s",
    async (field) => {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[field];
      const result = await readCredentials(await writeJson(await scratchPath(), partial));
      expect(result.ok).toBe(false);
      // The QUOTED field name, not the bare word. `type` is deliberately not in this sweep:
      // deleting it takes the discriminator branch, whose message reads `…have type
      // undefined; expected "authorized_user".` — which satisfies a bare toContain("type")
      // through the words "have type" while naming no missing field at all. An assertion
      // that passes for the wrong reason is exactly what this task exists to prevent.
      if (!result.ok) expect(result.message).toContain(`"${field}"`);
    },
  );

  test("a missing type is reported as a wrong discriminator, naming both what it found and what it wanted", async () => {
    const partial: Record<string, unknown> = { ...VALID };
    delete partial.type;
    const result = await readCredentials(await writeJson(await scratchPath(), partial));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("have type undefined");
      expect(result.message).toContain('expected "authorized_user"');
    }
  });
});

describe("FileTokenProvider.getAccessToken", () => {
  test("returns not-authorized, not a throw, when no credentials file exists yet", async () => {
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: await scratchPath(),
    });
    expect(await provider.getAccessToken()).toEqual({
      ok: false, error: { code: "not-authorized", message: expect.any(String) },
    });
  });

  test("returns not-authorized, not a throw, for a malformed file", async () => {
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s",
      credentialsPath: await writeRaw(await scratchPath(), "{ broken"),
    });
    expect(await provider.getAccessToken()).toEqual({
      ok: false, error: { code: "not-authorized", message: expect.any(String) },
    });
  });

  test("exchanges the stored refresh token for an access token", async () => {
    const path = await writeJson(await scratchPath(), VALID);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      // Test seam: injected refresher, not a live client. No live network in any test.
      refreshAccessToken: async (refreshToken: string) => {
        expect(refreshToken).toBe("rt-1");
        return { ok: true, token: "access-token-1" };
      },
    });
    expect(await provider.getAccessToken()).toEqual({ ok: true, token: "access-token-1" });
  });

  test("maps invalid_grant to revoked", async () => {
    const path = await writeJson(await scratchPath(), VALID);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      refreshAccessToken: async () => { throw Object.assign(new Error("invalid_grant"), { code: "invalid_grant" }); },
    });
    expect(await provider.getAccessToken()).toEqual({
      ok: false, error: { code: "revoked", message: expect.any(String) },
    });
  });

  test("maps a network failure to transport", async () => {
    const path = await writeJson(await scratchPath(), VALID);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      refreshAccessToken: async () => { throw new Error("ENOTFOUND"); },
    });
    expect(await provider.getAccessToken()).toEqual({
      ok: false, error: { code: "transport", message: expect.any(String) },
    });
  });

  test("no user-facing message names a command that no longer exists", async () => {
    // These two strings compile fine while being wrong, so nothing else catches them.
    // BOTH are rewritten by this task, so both are asserted here. Covering only the
    // missing-file path is how the `revoked` message survives the change by accident —
    // the same "compiles fine while being wrong" failure this test exists to catch.
    const missing = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: await scratchPath(),
    });
    const missingResult = await missing.getAccessToken();
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.error.message).not.toContain("google-login");

    const revoked = new FileTokenProvider({
      clientId: "c", clientSecret: "s",
      credentialsPath: await writeJson(await scratchPath(), VALID),
      refreshAccessToken: async () => { throw Object.assign(new Error("invalid_grant"), { code: "invalid_grant" }); },
    });
    const revokedResult = await revoked.getAccessToken();
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) {
      expect(revokedResult.error.code).toBe("revoked");
      expect(revokedResult.error.message).not.toContain("google-login");
      expect(revokedResult.error.message).toContain("reconnect");
    }
  });
});
