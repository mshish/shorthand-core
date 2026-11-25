import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { docs_v1 } from "@googleapis/docs";
import { resolveGoogleDocsSink } from "../src/google/capture-sink.js";
import type { DocsApiResult, DocsTab, GetDocumentValue, GoogleDocsApi } from "../src/google/docs-client.js";
import type { GoogleCredentials } from "../src/google/file-token-provider.js";
import { resolveGoogleTranscriptMirror, transcriptSections } from "../src/google/transcript-mirror.js";
import { SidecarWriter } from "../src/note/sidecar.js";

const VALID: GoogleCredentials = {
  type: "authorized_user",
  client_id: "1234567890-test.apps.googleusercontent.com",
  client_secret: "test-client-secret",
  refresh_token: "rt-1",
  document_id: "shared-doc",
};

const SIDECAR = `# Shorthand Transcript

> [!info] Commit timing
> Timestamps below are **COMMIT time**—when text became committed—not speech time.

## Connection 1 · Session 7
**[COMMIT +00:01.000] Ana:** Hello there.
**[COMMIT +00:04.500] Ben:** Morning.

> [!warning] Incomplete session
> The connection ended before a terminal event was received.`;

function tab(tabId: string, childTabs: DocsTab[] = []): DocsTab {
  return { tabId, bodyEndIndex: 2, paragraphs: [], childTabs };
}

type Recorder = {
  api: GoogleDocsApi;
  minted: Array<{ documentId: string; title: string; parentTabId: string | undefined }>;
  writes: Array<{ documentId: string; requests: readonly docs_v1.Schema$Request[]; revision: string | undefined }>;
  tabs: DocsTab[];
};

function recorder(initialTabs: DocsTab[], failWrites = 0): Recorder {
  const record: Recorder = { minted: [], writes: [], tabs: initialTabs, api: undefined as unknown as GoogleDocsApi };
  let failuresLeft = failWrites;
  record.api = {
    getDocument: async (): Promise<DocsApiResult<GetDocumentValue>> => ({ ok: true, value: { revisionId: "r1", tabs: record.tabs } }),
    batchUpdate: async (documentId, requests, revision) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return { ok: false, error: { httpStatus: 503, message: "busy", retryAfterMs: 5 } };
      }
      record.writes.push({ documentId, requests, revision });
      return { ok: true, value: { revisionId: "r2" } };
    },
    addDocumentTab: async (documentId, title, options) => {
      const tabId = `minted-${record.minted.length + 1}`;
      record.minted.push({ documentId, title, parentTabId: options?.parentTabId });
      const created = tab(tabId);
      if (options?.parentTabId === undefined) {
        record.tabs = [...record.tabs, created];
      } else {
        const parentId = options.parentTabId;
        record.tabs = record.tabs.map((each) => (each.tabId === parentId ? { ...each, childTabs: [...each.childTabs, created] } : each));
      }
      return { ok: true, value: { tabId } };
    },
  };
  return record;
}

async function setup(): Promise<{ directory: string; credentialsPath: string; capturesDirectory: string; note: string }> {
  const directory = await mkdtemp(join(tmpdir(), "google-transcript-mirror-"));
  const credentialsPath = join(directory, "google-credentials.json");
  await writeFile(credentialsPath, JSON.stringify(VALID), "utf8");
  return { directory, credentialsPath, capturesDirectory: join(directory, "captures"), note: join(directory, "Standup.md") };
}

function insertedText(requests: readonly docs_v1.Schema$Request[]): string {
  return requests.flatMap((request) => (request.insertText?.text === undefined || request.insertText.text === null ? [] : [request.insertText.text])).join("");
}

describe("resolveGoogleTranscriptMirror", () => {
  test("a tab per meeting nests the transcript under the meeting's tab", async () => {
    const { credentialsPath, capturesDirectory, note } = await setup();
    const docs = recorder([]);
    const sink = await resolveGoogleDocsSink(note, {}, { credentialsPath, capturesDirectory, api: docs.api });
    expect(sink.ok).toBe(true);
    const result = await resolveGoogleTranscriptMirror(note, {}, { credentialsPath, capturesDirectory, api: docs.api, intervalMs: 5 });
    expect(result.ok).toBe(true);
    expect(docs.minted).toEqual([
      { documentId: "shared-doc", title: "Standup", parentTabId: undefined },
      { documentId: "shared-doc", title: "Transcript", parentTabId: "minted-1" },
    ]);
    const entries = await readdir(capturesDirectory);
    const state = JSON.parse(await readFile(join(capturesDirectory, entries[0]!), "utf8"));
    expect(state).toMatchObject({ documentId: "shared-doc", tabId: "minted-1", transcriptTabId: "minted-2" });
  });

  test("a meeting's own doc gets a top-level transcript tab beside the notes", async () => {
    const { credentialsPath, capturesDirectory, note } = await setup();
    const docs = recorder([tab("notes-tab")]);
    const result = await resolveGoogleTranscriptMirror(note, {}, {
      credentialsPath, capturesDirectory, api: docs.api, documentId: "meeting-doc", intervalMs: 5,
    });
    expect(result.ok).toBe(true);
    expect(docs.minted).toEqual([{ documentId: "meeting-doc", title: "Transcript", parentTabId: undefined }]);
  });

  test("a resumed capture reuses its transcript tab, and re-mints one deleted from the doc", async () => {
    const { credentialsPath, capturesDirectory, note } = await setup();
    const docs = recorder([tab("notes-tab")]);
    const options = { credentialsPath, capturesDirectory, api: docs.api, documentId: "meeting-doc", intervalMs: 5 };
    await resolveGoogleTranscriptMirror(note, {}, options);
    await resolveGoogleTranscriptMirror(note, {}, options);
    expect(docs.minted.length).toBe(1);
    docs.tabs = [tab("notes-tab")];
    const again = await resolveGoogleTranscriptMirror(note, {}, options);
    expect(docs.minted.length).toBe(2);
    expect(again.ok && again.mirror.tabId).toBe("minted-2");
  });

  test("pushes the latest transcript once per interval and once more on close, without writeControl", async () => {
    const { credentialsPath, capturesDirectory, note } = await setup();
    const docs = recorder([tab("notes-tab")]);
    const result = await resolveGoogleTranscriptMirror(note, {}, {
      credentialsPath, capturesDirectory, api: docs.api, documentId: "meeting-doc", intervalMs: 20,
    });
    if (!result.ok) throw new Error(result.message);
    result.mirror.offer(`${SIDECAR}\n`);
    result.mirror.offer(SIDECAR);
    await Bun.sleep(60);
    expect(docs.writes.length).toBe(1);
    expect(docs.writes[0]!.revision).toBeUndefined();
    expect(insertedText(docs.writes[0]!.requests)).toContain("Ana: Hello there.");
    const later = `${SIDECAR}\n\n## Connection 1 · Session 8\n**[COMMIT +00:09.000] Ana:** Bye.`;
    result.mirror.offer(later);
    await result.mirror.close();
    expect(docs.writes.length).toBe(2);
    expect(insertedText(docs.writes[1]!.requests)).toContain("Bye.");
    result.mirror.offer(`${later} more`);
    await Bun.sleep(40);
    expect(docs.writes.length).toBe(2);
  });

  test("a failed push is tried again without waiting for a new change", async () => {
    const { credentialsPath, capturesDirectory, note } = await setup();
    const docs = recorder([tab("notes-tab")], 1);
    const errors: string[] = [];
    const result = await resolveGoogleTranscriptMirror(note, {}, {
      credentialsPath, capturesDirectory, api: docs.api, documentId: "meeting-doc", intervalMs: 10,
      onError: (message) => errors.push(message),
    });
    if (!result.ok) throw new Error(result.message);
    result.mirror.offer(SIDECAR);
    await Bun.sleep(80);
    expect(errors.length).toBe(1);
    expect(docs.writes.length).toBe(1);
    await result.mirror.close();
    expect(docs.writes.length).toBe(1);
  });

  test("fails with a message when the transcript tab can't be made", async () => {
    const { credentialsPath, capturesDirectory, note } = await setup();
    const docs = recorder([tab("notes-tab")]);
    docs.api.addDocumentTab = async () => ({ ok: false, error: { httpStatus: 403, message: "forbidden" } });
    const result = await resolveGoogleTranscriptMirror(note, {}, { credentialsPath, capturesDirectory, api: docs.api, documentId: "meeting-doc" });
    expect(result).toEqual({ ok: false, message: "Could not create the transcript tab: forbidden" });
  });
});

describe("transcriptSections", () => {
  test("drops the file header and callout markup, keeping one section per heading", () => {
    const sections = transcriptSections(SIDECAR);
    expect(sections.map((section) => section.heading)).toEqual(["Connection 1 · Session 7"]);
    expect(sections[0]!.markdown).toContain("**[COMMIT +00:01.000] Ana:** Hello there.");
    expect(sections[0]!.markdown).toContain("**Incomplete session**");
    expect(sections[0]!.markdown).toContain("The connection ended before a terminal event was received.");
    expect(sections[0]!.markdown).not.toContain("[!warning]");
    expect(sections[0]!.markdown).not.toContain("COMMIT time");
  });

  test("a sidecar with no sessions yet has nothing to show", () => {
    expect(transcriptSections("# Shorthand Transcript\n\n> [!info] Commit timing\n> x")).toEqual([]);
  });
});

describe("SidecarWriter onCommit", () => {
  test("hands each committed write's full text to the host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidecar-on-commit-"));
    const committed: string[] = [];
    const writer = new SidecarWriter(join(directory, "t.md"), { flushIntervalMs: 1, onCommit: (content) => committed.push(content) });
    await writer.flush();
    expect(committed.length).toBe(1);
    expect(committed[0]).toBe(await readFile(join(directory, "t.md"), "utf8"));
  });
});
