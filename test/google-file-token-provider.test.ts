import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTokenProvider, readCredentials, writeCredentials } from "../src/google/file-token-provider.js";

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
