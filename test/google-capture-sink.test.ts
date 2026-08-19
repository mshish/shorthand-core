import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGoogleDocsSink } from "../src/google/capture-sink.js";
import type { BatchUpdateValue, DocsApiResult, GetDocumentValue, GoogleDocsApi } from "../src/google/docs-client.js";
import type { GoogleCredentials } from "../src/google/file-token-provider.js";

const VALID: GoogleCredentials = {
  type: "authorized_user",
  client_id: "1234567890-test.apps.googleusercontent.com",
  client_secret: "test-client-secret",
  refresh_token: "rt-1",
  document_id: "doc-1",
};

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "google-capture-sink-"));
}

async function writeCredentials(directory: string, value: unknown): Promise<string> {
  const path = join(directory, "google-credentials.json");
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  return path;
}

function fakeApi(overrides: Partial<GoogleDocsApi> = {}): GoogleDocsApi {
  return {
    getDocument: async (): Promise<DocsApiResult<GetDocumentValue>> => ({ ok: true, value: { revisionId: "r1", tabs: [] } }),
    batchUpdate: async (): Promise<DocsApiResult<BatchUpdateValue>> => ({ ok: true, value: { revisionId: "r2" } }),
    addDocumentTab: async () => ({ ok: true, value: { tabId: "minted-tab" } }),
    ...overrides,
  };
}

async function onlyStateFile(capturesDirectory: string): Promise<{ path: string; contents: Record<string, unknown> }> {
  const entries = await readdir(capturesDirectory);
  expect(entries.length).toBe(1);
  const path = join(capturesDirectory, entries[0]!);
  return { path, contents: JSON.parse(await readFile(path, "utf8")) };
}

describe("resolveGoogleDocsSink", () => {
  test("mints a tab and writes the state file on first run", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    let mintedTitle: string | undefined;
    const api = fakeApi({
      addDocumentTab: async (documentId, title) => {
        expect(documentId).toBe("doc-1");
        mintedTitle = title;
        return { ok: true, value: { tabId: "fresh-tab" } };
      },
    });
    const result = await resolveGoogleDocsSink(join(directory, "meeting.md"), {}, { credentialsPath, capturesDirectory, api });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sink.describe).toBe("Google Doc doc-1 (tab fresh-tab)");
    expect(mintedTitle).toBe("meeting");
    const state = await onlyStateFile(capturesDirectory);
    expect(state.contents.documentId).toBe("doc-1");
    expect(state.contents.tabId).toBe("fresh-tab");
    expect(typeof state.contents.createdAt).toBe("string");
  });

  test("reuses the persisted tabId on a second call for the same note (crash-resume)", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    let mintCount = 0;
    const api = fakeApi({ addDocumentTab: async () => { mintCount += 1; return { ok: true, value: { tabId: `tab-${mintCount}` } }; } });
    const notePath = join(directory, "meeting.md");
    const first = await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    const second = await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    expect(first.ok && second.ok).toBe(true);
    expect(mintCount).toBe(1);
    if (first.ok && second.ok) expect(second.sink.describe).toBe(first.sink.describe);
  });

  test("re-mints when the credentials file's document_id has changed since the last run", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    let mintCount = 0;
    const api = fakeApi({ addDocumentTab: async () => { mintCount += 1; return { ok: true, value: { tabId: `tab-${mintCount}` } }; } });
    const notePath = join(directory, "meeting.md");
    await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    await writeCredentials(directory, { ...VALID, document_id: "doc-2" });
    const second = await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    expect(mintCount).toBe(2);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.sink.describe).toBe("Google Doc doc-2 (tab tab-2)");
    const state = await onlyStateFile(capturesDirectory);
    expect(state.contents.documentId).toBe("doc-2");
  });

  test("a corrupt state file is not an error — resolves ok with a freshly minted tab", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    let mintCount = 0;
    const api = fakeApi({ addDocumentTab: async () => { mintCount += 1; return { ok: true, value: { tabId: `tab-${mintCount}` } }; } });
    const notePath = join(directory, "meeting.md");
    await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    const { path } = await onlyStateFile(capturesDirectory);
    await writeFile(path, "{not valid json", "utf8");
    const second = await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    expect(second.ok).toBe(true);
    expect(mintCount).toBe(2);
  });

  test("fails clearly, without naming any consumer app, when credentials are unreadable", async () => {
    const directory = await scratchDir();
    const capturesDirectory = join(directory, "captures");
    const result = await resolveGoogleDocsSink(join(directory, "meeting.md"), {}, {
      credentialsPath: join(directory, "does-not-exist.json"),
      capturesDirectory,
      api: fakeApi(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("connect your Google account");
    expect(result.message).not.toContain("shorthand-config");
  });

  test("fails clearly, without naming any consumer app, when document_id is absent", async () => {
    const directory = await scratchDir();
    const { document_id: _omit, ...withoutDocument } = VALID;
    const credentialsPath = await writeCredentials(directory, withoutDocument);
    const capturesDirectory = join(directory, "captures");
    const result = await resolveGoogleDocsSink(join(directory, "meeting.md"), {}, { credentialsPath, capturesDirectory, api: fakeApi() });
    expect(result).toEqual({
      ok: false,
      message: "No Google Doc selected; connect your Google account and choose a target document, then retry.",
    });
  });

  test("fails clearly when minting the tab itself fails", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    const api = fakeApi({ addDocumentTab: async () => ({ ok: false, error: { httpStatus: 403, message: "forbidden" } }) });
    const result = await resolveGoogleDocsSink(join(directory, "meeting.md"), {}, { credentialsPath, capturesDirectory, api });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("forbidden");
  });

  test.skipIf(process.platform !== "win32")(
    "on Windows, paths differing only by case reach the same captureId",
    async () => {
      const directory = await scratchDir();
      const credentialsPath = await writeCredentials(directory, VALID);
      const capturesDirectory = join(directory, "captures");
      let mintCount = 0;
      const api = fakeApi({ addDocumentTab: async () => { mintCount += 1; return { ok: true, value: { tabId: `tab-${mintCount}` } }; } });
      const notePath = join(directory, "Meeting.md");
      await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
      await resolveGoogleDocsSink(notePath.toUpperCase(), {}, { credentialsPath, capturesDirectory, api });
      expect(mintCount).toBe(1);
    },
  );
});
