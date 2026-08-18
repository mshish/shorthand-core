import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTokenProvider, defaultRefresher, mergeCredentials, readCredentials, writeCredentials } from "../src/google/file-token-provider.js";
import type { GoogleCredentials } from "../src/google/file-token-provider.js";

async function scratchPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "google-token-"));
  return join(directory, "google-credentials.json");
}

describe("writeCredentials / readCredentials", () => {
  test("round-trips and is written with 0600 permissions", async () => {
    const path = await scratchPath();
    await writeCredentials({ refreshToken: "rt-1", documentId: "doc-1", tabId: "tab-1" }, path);
    expect(await readCredentials(path)).toEqual({ refreshToken: "rt-1", documentId: "doc-1", tabId: "tab-1" });
    if (process.platform !== "win32") {
      const stats = await import("node:fs/promises").then((fs) => fs.stat(path));
      expect(stats.mode & 0o777).toBe(0o600);
    }
    await rm(path, { force: true });
  });

  test("readCredentials returns undefined when the file does not exist", async () => {
    expect(await readCredentials(await scratchPath())).toBeUndefined();
  });
});

describe("mergeCredentials", () => {
  test("preserves an existing tabId when a google-login run doesn't specify one", () => {
    // Regression: writeCredentials({ refreshToken, documentId }) overwrites the
    // whole credentials file unconditionally. A re-login that only ever passed
    // the two fields it obtained from the OAuth exchange would otherwise
    // silently drop a tabId some other path had stored there.
    const existing: GoogleCredentials = { refreshToken: "old-rt", documentId: "old-doc", tabId: "tab-1" };
    const merged = mergeCredentials(existing, { refreshToken: "new-rt", documentId: "new-doc" });
    expect(merged).toEqual({ refreshToken: "new-rt", documentId: "new-doc", tabId: "tab-1" });
  });

  test("produces credentials without a tabId when none existed before", () => {
    const merged = mergeCredentials(undefined, { refreshToken: "new-rt", documentId: "new-doc" });
    expect(merged).toEqual({ refreshToken: "new-rt", documentId: "new-doc" });
  });

  test("preserves an existing folderId when the update doesn't specify one", () => {
    const existing: GoogleCredentials = { refreshToken: "old-rt", documentId: "old-doc", folderId: "folder-1" };
    const merged = mergeCredentials(existing, { refreshToken: "new-rt", documentId: "new-doc" });
    expect(merged).toEqual({ refreshToken: "new-rt", documentId: "new-doc", folderId: "folder-1" });
  });

  test("a new folderId in the update overrides an existing one", () => {
    const existing: GoogleCredentials = { refreshToken: "old-rt", documentId: "old-doc", folderId: "folder-1" };
    const merged = mergeCredentials(existing, { refreshToken: "new-rt", documentId: "new-doc", folderId: "folder-2" });
    expect(merged).toEqual({ refreshToken: "new-rt", documentId: "new-doc", folderId: "folder-2" });
  });

  test("omits folderId entirely when neither existing nor update has one", () => {
    const merged = mergeCredentials(undefined, { refreshToken: "new-rt", documentId: "new-doc" });
    expect(merged).toEqual({ refreshToken: "new-rt", documentId: "new-doc" });
    expect("folderId" in merged).toBe(false);
  });
});

describe("FileTokenProvider.getAccessToken", () => {
  test("returns not-authorized when no credentials file exists yet", async () => {
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: await scratchPath(),
    });
    const result = await provider.getAccessToken();
    expect(result).toEqual({ ok: false, error: { code: "not-authorized", message: expect.any(String) } });
  });

  test("exchanges the stored refresh token for an access token", async () => {
    const path = await scratchPath();
    await writeCredentials({ refreshToken: "rt-1", documentId: "doc-1" }, path);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      // Test seam: injected refresher, not a live OAuth2Client, per the plan's
      // "no live network in any test" constraint.
      refreshAccessToken: async (refreshToken: string) => {
        expect(refreshToken).toBe("rt-1");
        return { ok: true, token: "access-token-1" };
      },
    } as never);
    expect(await provider.getAccessToken()).toEqual({ ok: true, token: "access-token-1" });
  });

  test("maps invalid_grant to revoked", async () => {
    const path = await scratchPath();
    await writeCredentials({ refreshToken: "rt-1", documentId: "doc-1" }, path);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      refreshAccessToken: async () => { throw Object.assign(new Error("invalid_grant"), { code: "invalid_grant" }); },
    } as never);
    expect(await provider.getAccessToken()).toEqual({ ok: false, error: { code: "revoked", message: expect.any(String) } });
  });

  test("maps a network failure to transport", async () => {
    const path = await scratchPath();
    await writeCredentials({ refreshToken: "rt-1", documentId: "doc-1" }, path);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      refreshAccessToken: async () => { throw new Error("ENOTFOUND"); },
    } as never);
    expect(await provider.getAccessToken()).toEqual({ ok: false, error: { code: "transport", message: expect.any(String) } });
  });
});

describe("defaultRefresher's client caching", () => {
  test("constructs the underlying client once, not once per call", async () => {
    let clientsCreated = 0;
    const refresher = defaultRefresher("client-id", "client-secret", () => {
      clientsCreated += 1;
      let accessToken = "token-from-first-refresh";
      return {
        setCredentials: () => {},
        getAccessToken: async () => ({ token: accessToken }),
      };
    });
    const first = await refresher("refresh-token-1");
    const second = await refresher("refresh-token-1");
    expect(first).toEqual({ ok: true, token: "token-from-first-refresh" });
    expect(second).toEqual({ ok: true, token: "token-from-first-refresh" });
    expect(clientsCreated).toBe(1);
  });
});
