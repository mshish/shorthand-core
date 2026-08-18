import { describe, expect, test } from "bun:test";
import { GoogleDocsNoteSink } from "../src/google/docs-sink.js";
import type { GoogleDocsApi, GetDocumentValue, BatchUpdateValue, DocsApiResult } from "../src/google/docs-client.js";

function fakeApi(overrides: Partial<GoogleDocsApi> = {}): GoogleDocsApi {
  return {
    getDocument: async (): Promise<DocsApiResult<GetDocumentValue>> => ({
      ok: true,
      value: { revisionId: "rev1", tabs: [{ tabId: "owned", bodyEndIndex: 1, paragraphs: [], childTabs: [] }] },
    }),
    batchUpdate: async (): Promise<DocsApiResult<BatchUpdateValue>> => ({ ok: true, value: { revisionId: "rev2" } }),
    ...overrides,
  };
}

describe("GoogleDocsNoteSink.read", () => {
  test("locates the owned tab by tabId, not position", async () => {
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev1",
          tabs: [
            { tabId: "someone-elses-notes", bodyEndIndex: 40, paragraphs: [], childTabs: [] },
            { tabId: "owned", bodyEndIndex: 1, paragraphs: [], childTabs: [] },
          ],
        },
      }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.read();
    expect(result.ok).toBe(true);
  });

  test("finds a tab nested under childTabs", async () => {
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev1",
          tabs: [{ tabId: "root", bodyEndIndex: 1, paragraphs: [], childTabs: [{ tabId: "owned", bodyEndIndex: 1, paragraphs: [], childTabs: [] }] }],
        },
      }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    expect((await sink.read()).ok).toBe(true);
  });

  test("reconstructs sections from the tab's paragraphs", async () => {
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev1",
          tabs: [{
            tabId: "owned",
            bodyEndIndex: 1,
            childTabs: [],
            paragraphs: [
              { text: "Summary", headingLevel: 2, bullet: false },
              { text: "Shipped Friday.", bullet: false },
              { text: "Decisions", headingLevel: 2, bullet: false },
              { text: "Ship it", bullet: true },
              { text: "Skip the retro", bullet: true },
            ],
          }],
        },
      }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.read();
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.sections).toEqual([
      { heading: "Summary", markdown: "Shipped Friday." },
      { heading: "Decisions", markdown: "- Ship it\n- Skip the retro" },
    ]);
    expect(result.value.userNotes).toBe("");
  });

  test("a missing owned tab reads as invalid-target", async () => {
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "missing", api: fakeApi() });
    expect(await sink.read()).toMatchObject({ ok: false, error: { code: "invalid-target" } });
  });

  test.each([
    [401, "forbidden"], [403, "forbidden"], [404, "not-found"], [429, "busy"], [500, "transport"],
  ])("httpStatus %d maps to read error code %s", async (httpStatus, code) => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ getDocument: async () => ({ ok: false, error: { httpStatus, message: "x" } }) }),
    });
    expect(await sink.read()).toMatchObject({ ok: false, error: { code } });
  });
});

describe("GoogleDocsNoteSink.write", () => {
  test("a successful write returns the new revisionId", async () => {
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api: fakeApi() });
    const result = await sink.write([{ heading: "Summary", markdown: "Shipped." }], "rev1");
    expect(result).toEqual({ status: "written", revision: "rev2" });
  });

  test("returns unchanged, without calling batchUpdate, when the rendered text already matches", async () => {
    let batchUpdateCalled = false;
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev1",
          tabs: [{
            tabId: "owned", bodyEndIndex: 1, childTabs: [],
            paragraphs: [
              { text: "Summary", headingLevel: 2, bullet: false },
              { text: "Shipped.", bullet: false },
            ],
          }],
        },
      }),
      batchUpdate: async () => { batchUpdateCalled = true; return { ok: true, value: { revisionId: "rev2" } }; },
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.write([{ heading: "Summary", markdown: "Shipped." }], "rev1");
    expect(result).toEqual({ status: "unchanged", revision: "rev1" });
    expect(batchUpdateCalled).toBe(false);
  });

  test("staleness outranks equality: identical content at a stale revision is still stale, not unchanged", async () => {
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev2",
          tabs: [{
            tabId: "owned", bodyEndIndex: 1, childTabs: [],
            paragraphs: [
              { text: "Summary", headingLevel: 2, bullet: false },
              { text: "Shipped.", bullet: false },
            ],
          }],
        },
      }),
      batchUpdate: async () => ({ ok: false, error: { httpStatus: 409, message: "stale" } }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.write([{ heading: "Summary", markdown: "Shipped." }], "rev1");
    expect(result).toEqual({ status: "stale" });
  });

  test("targetRevisionId is passed through as expectedRevision", async () => {
    let capturedRevision: string | undefined;
    const api = fakeApi({
      batchUpdate: async (_documentId, _requests, targetRevisionId) => {
        capturedRevision = targetRevisionId;
        return { ok: true, value: { revisionId: "rev2" } };
      },
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    await sink.write([{ heading: "Summary", markdown: "x" }], "rev1");
    expect(capturedRevision).toBe("rev1");
  });

  test.each([
    [409, "stale"], [412, "stale"],
  ])("httpStatus %d maps to write status %s", async (httpStatus, status) => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus, message: "x" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toEqual({ status: status as "stale" });
  });

  test("httpStatus 429 maps to busy with retryAfterMs carried through", async () => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus: 429, retryAfterMs: 3000, message: "x" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toEqual({ status: "busy", retryAfterMs: 3000 });
  });

  test("httpStatus 401/403 maps to a forbidden error status", async () => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus: 403, message: "x" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toMatchObject({ status: "error", error: { code: "forbidden" } });
  });

  test("agentContext is never set", () => {
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api: fakeApi() });
    expect(sink.agentContext).toBeUndefined();
  });

  test("describe defaults to the document id when not supplied", () => {
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api: fakeApi() });
    expect(sink.describe).toContain("d1");
  });
});
