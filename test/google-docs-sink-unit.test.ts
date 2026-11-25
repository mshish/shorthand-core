import { describe, expect, test } from "bun:test";
import { GoogleDocsNoteSink } from "../src/google/docs-sink.js";
import type { GoogleDocsApi, GetDocumentValue, BatchUpdateValue, DocsApiResult } from "../src/google/docs-client.js";
import { renderSections } from "../src/google/renderer.js";
import type { DocsParagraph } from "../src/google/docs-client.js";
import type { Section } from "../src/note/markers.js";

function fakeApi(overrides: Partial<GoogleDocsApi> = {}): GoogleDocsApi {
  return {
    getDocument: async (): Promise<DocsApiResult<GetDocumentValue>> => ({
      ok: true,
      value: { revisionId: "rev1", tabs: [{ tabId: "owned", bodyEndIndex: 1, paragraphs: [], childTabs: [] }] },
    }),
    batchUpdate: async (): Promise<DocsApiResult<BatchUpdateValue>> => ({ ok: true, value: { revisionId: "rev2" } }),
    addDocumentTab: async () => ({ ok: true, value: { tabId: "unused-tab" } }),
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
      { heading: "Decisions", markdown: "* Ship it\n* Skip the retro" },
    ]);
    expect(result.value.userNotes).toBe("");
  });

  test("keeps subheadings, list nesting and kind, ticked items, and inline styling", async () => {
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
              { text: "Plan", headingLevel: 2, bullet: false },
              { text: "Steps", headingLevel: 3, bullet: false },
              { text: "Draft", bullet: true, listKind: "numbered" },
              { text: "Outline", bullet: true, listKind: "numbered", nestingLevel: 1 },
              { text: "Mike sends it", markdown: "**Mike** sends it", bullet: true, listKind: "checkbox" },
              { text: "Room booked", bullet: true, listKind: "checkbox", checked: true },
              { text: "Takeaway: ship", markdown: "**Takeaway:** ship", bullet: false },
            ],
          }],
        },
      }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.read();
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.sections).toEqual([
      {
        heading: "Plan",
        markdown: "### Steps\n\n1. Draft\n    1. Outline\n* [ ] **Mike** sends it\n* [x] Room booked\n\n**Takeaway:** ship",
      },
    ]);
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

  test("httpStatus 503 maps to busy with retryAfterMs carried through, not transport", async () => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ getDocument: async () => ({ ok: false, error: { httpStatus: 503, retryAfterMs: 2000, message: "x" } }) }),
    });
    expect(await sink.read()).toMatchObject({ ok: false, error: { code: "busy", retryAfterMs: 2000 } });
  });

  test("cause is carried through from the DocsApiError to the resulting SinkError", async () => {
    const cause = new Error("underlying gaxios failure");
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ getDocument: async () => ({ ok: false, error: { httpStatus: 500, message: "x", cause } }) }),
    });
    const result = await sink.read();
    expect(result).toMatchObject({ ok: false, error: { code: "transport", cause } });
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
    [400, "stale"], [409, "stale"], [412, "stale"],
  ])("httpStatus %d maps to write status %s", async (httpStatus, status) => {
    // The real Google Docs API returns 400 (not 409/412) for a targetRevisionId
    // conflict; see the "Concurrency" section of this feature's spec.
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

  test("httpStatus 503 maps to busy with retryAfterMs carried through, not transport", async () => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus: 503, retryAfterMs: 4000, message: "x" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toEqual({ status: "busy", retryAfterMs: 4000 });
  });

  test("httpStatus 401/403 maps to a forbidden error status", async () => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus: 403, message: "x" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toMatchObject({ status: "error", error: { code: "forbidden" } });
  });

  test("a token-provider revoked error (mapped to httpStatus 401) reports forbidden, not transport", async () => {
    // The 401 mapping is produced upstream by GoogleApiDocsClient's
    // getRequestHeaders/getRequestMetadataAsync override (see
    // test/google-docs-client.test.ts's "TokenProvider error mapping"
    // suite); this confirms the sink's own 401 handling completes that chain
    // by reporting "forbidden" rather than a generic transport failure.
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus: 401, message: "revoked" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toMatchObject({
      status: "error",
      error: { code: "forbidden" },
    });
  });

  test("cause is carried through from the DocsApiError to the resulting write SinkError", async () => {
    const cause = new Error("underlying gaxios failure");
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus: 500, message: "x", cause } }) }),
    });
    const result = await sink.write([{ heading: "Summary", markdown: "x" }], "rev1");
    expect(result).toMatchObject({ status: "error", error: { code: "transport", cause } });
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

/**
 * Stores rendered text the way the Docs API leaves it after buildWriteRequests:
 * one paragraph per line, list paragraphs with their leading tabs turned into a
 * nesting level, and a struck-through checklist item reading as ticked.
 */
function storedParagraphs(sections: readonly Section[]): DocsParagraph[] {
  const { text, spans } = renderSections(sections);
  const paragraphs: DocsParagraph[] = [];
  let offset = 0;
  for (const line of text.split("\n").slice(0, -1)) {
    const start = offset;
    offset += line.length + 1;
    const heading = spans.find((span) => span.style.kind === "heading" && span.start === start);
    const list = spans.find((span) => span.style.kind === "list" && span.start <= start && start < span.end);
    const preset = list?.style.kind === "list" ? list.style.preset : undefined;
    const depth = /^\t*/.exec(line)![0].length;
    const struck = spans.some((span) => span.style.kind === "strikethrough" && span.start === start + depth && span.end === start + line.length);
    paragraphs.push({
      text: line.slice(depth),
      ...(heading?.style.kind === "heading" ? { headingLevel: heading.style.level } : {}),
      bullet: preset !== undefined,
      ...(depth > 0 ? { nestingLevel: depth } : {}),
      ...(preset === "numbered" || preset === "checkbox" ? { listKind: preset } : {}),
      ...(preset === "checkbox" && struck ? { checked: true as const } : {}),
    });
  }
  return paragraphs;
}

describe("GoogleDocsNoteSink round trip", () => {
  test("reading back a written note renders the same text, so an unchanged pass stays unchanged", async () => {
    const sections: readonly Section[] = [
      { heading: "Summary", markdown: "We agreed to **ship Friday**.\n\nA *second* thought." },
      {
        heading: "Plan",
        markdown: "### Steps\n\n1. Draft\n2. Review\n    * Legal\n        * Contract\n\nThen a paragraph.\n\n* [ ] **Mike** sends the deck\n* [x] Room booked\n\n* An idea\n* [ ] A stray task",
      },
    ];
    const paragraphs = storedParagraphs(sections);
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: { revisionId: "rev1", tabs: [{ tabId: "owned", bodyEndIndex: 1, paragraphs, childTabs: [] }] },
      }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const read = await sink.read();
    if (!read.ok) throw new Error("expected ok");
    expect(renderSections(read.value.sections).text).toBe(renderSections(sections).text);
    expect(await sink.write(sections, "rev1")).toEqual({ status: "unchanged", revision: "rev1" });
  });
});

describe("GoogleDocsNoteSink status lines and title", () => {
  type Batch = { requests: readonly Record<string, any>[]; revision: string | undefined };
  function recordingApi(paragraphs: DocsParagraph[] = []) {
    const batches: Batch[] = [];
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: { revisionId: "rev1", tabs: [{ tabId: "owned", bodyEndIndex: 1, paragraphs, childTabs: [] }] },
      }),
      batchUpdate: async (_id, requests, revision) => {
        batches.push({ requests: requests as Batch["requests"], revision });
        return { ok: true, value: { revisionId: "rev2" } };
      },
    });
    return { api, batches };
  }
  const insertedText = (batch: Batch) => batch.requests.find((request) => request.insertText)?.insertText.text as string;
  const startedAt = new Date("2026-11-25T21:00:00Z");
  const common = { documentId: "d1", tabId: "owned", startedAt, locale: "en-US", timeZone: "America/New_York" } as const;

  test("a standalone enhance, which never calls begin, writes no status lines", async () => {
    const { api, batches } = recordingApi();
    const sink = new GoogleDocsNoteSink({ ...common, api });
    await sink.write([{ heading: "Summary", markdown: "Hi." }], "rev1");
    expect(insertedText(batches[0]!)).toBe("Summary\nHi.\n");
  });

  test("begin shows Taking notes with the start, linked to Shorthand, in small grey text", async () => {
    const { api, batches } = recordingApi();
    const sink = new GoogleDocsNoteSink({ ...common, api, now: () => new Date("2026-11-25T21:00:00Z") });
    await sink.begin();
    expect(insertedText(batches[0]!)).toBe("📝 Taking notes · Updated 4:00 PM · by Shorthand\nWed, Nov 25, 2026 · Started 4:00 PM\n");
    const styles = batches[0]!.requests.filter((request) => request.updateTextStyle).map((request) => request.updateTextStyle);
    expect(styles.some((style) => style.textStyle.link?.url === "https://shorthand.ing")).toBe(true);
    expect(styles.filter((style) => style.fields === "foregroundColor,fontSize")).toHaveLength(2);
  });

  test("the Updated time moves only when the notes change, and finish reports the length", async () => {
    let now = new Date("2026-11-25T21:00:00Z");
    const { api, batches } = recordingApi();
    const sink = new GoogleDocsNoteSink({ ...common, api, now: () => now });
    await sink.begin();
    now = new Date("2026-11-25T21:12:00Z");
    await sink.write([{ heading: "Summary", markdown: "Pricing." }], "rev1");
    expect(insertedText(batches[1]!)).toStartWith("📝 Taking notes · Updated 4:12 PM · by Shorthand\n");
    expect(insertedText(batches[1]!)).toEndWith("Summary\nPricing.\n");
    now = new Date("2026-11-25T22:05:00Z");
    await sink.finish("complete");
    expect(insertedText(batches[2]!)).toStartWith("✅ Notes complete · 5:05 PM\nWed, Nov 25, 2026 · Started 4:00 PM · 1 hr 5 min\n");
  });

  test("finish says the notes stopped early", async () => {
    let now = new Date("2026-11-25T21:00:00Z");
    const { api, batches } = recordingApi();
    const sink = new GoogleDocsNoteSink({ ...common, api, now: () => now });
    await sink.begin();
    now = new Date("2026-11-25T21:32:00Z");
    await sink.finish("stopped");
    expect(insertedText(batches[1]!)).toBe("⚠️ Notes stopped early · 4:32 PM\nWed, Nov 25, 2026 · Started 4:00 PM · 32 min\n");
  });

  test("the status lines are never read back as notes", async () => {
    const { text } = renderSections([{ heading: "Summary", markdown: "Hi." }], ["📝 Taking notes", "Started"]);
    const paragraphs: DocsParagraph[] = text.split("\n").filter((line) => line.length > 0).map((line) => (
      line === "Summary" ? { text: line, headingLevel: 2, bullet: false } : { text: line, bullet: false }
    ));
    const sink = new GoogleDocsNoteSink({ ...common, api: recordingApi(paragraphs).api });
    const read = await sink.read();
    expect(read.ok && read.value.sections).toEqual([{ heading: "Summary", markdown: "Hi." }]);
  });

  test("setTitle renames the tab date first and reports the name once", async () => {
    const { api, batches } = recordingApi();
    const names: string[] = [];
    const sink = new GoogleDocsNoteSink({ ...common, api, onRenamed: (name) => names.push(name) });
    await sink.setTitle("Q1 pricing review");
    await sink.setTitle("Q1 pricing review");
    expect(batches).toHaveLength(1);
    expect(batches[0]!.requests[0]).toEqual({
      updateDocumentTabProperties: { tabProperties: { tabId: "owned", title: "2026-11-25 - Q1 pricing review" }, fields: "title" },
    });
    expect(names).toEqual(["2026-11-25 - Q1 pricing review"]);
  });

  test("a doc made for one meeting keeps its tab name and leaves the rename to the host", async () => {
    const { api, batches } = recordingApi();
    const names: string[] = [];
    const sink = new GoogleDocsNoteSink({ ...common, api, renameTab: false, onRenamed: (name) => names.push(name) });
    await sink.setTitle("Roadmap");
    expect(batches).toHaveLength(0);
    expect(names).toEqual(["2026-11-25 - Roadmap"]);
  });
});
