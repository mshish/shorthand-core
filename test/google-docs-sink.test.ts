import { describe, test } from "bun:test";
import { describeNoteSinkConformance, type SinkHarness } from "shorthand-core/testing";
import { GoogleDocsNoteSink } from "../src/google/docs-sink.js";
import type { BatchUpdateValue, DocsApiResult, GetDocumentValue, GoogleDocsApi } from "../src/google/docs-client.js";
import type { Section } from "../src/note/markers.js";

const OWNED_TAB = "owned-tab";
const FOREIGN_TAB = "users-own-notes";

type FakeParagraph = { text: string; headingLevel?: 1 | 2 | 3; bullet: boolean };

const NAMED_STYLE_LEVEL: Record<string, 1 | 2 | 3> = { HEADING_1: 1, HEADING_2: 2, HEADING_3: 3 };

// The conformance suite ships as core API and knows no test runner; this file
// is the only place bun:test is bound to it for GoogleDocsNoteSink.
class FakeDocsApi implements GoogleDocsApi {
  #revisionId = 1;
  #ownedText = "";
  #ownedParagraphs: FakeParagraph[] = [];
  #foreignText = "unchanged foreign content";
  #forbidden = false;
  #missing = false;
  #busy = false;

  async getDocument(): Promise<DocsApiResult<GetDocumentValue>> {
    if (this.#missing) return { ok: false, error: { httpStatus: 404, message: "not found" } };
    if (this.#forbidden) return { ok: false, error: { httpStatus: 403, message: "forbidden" } };
    if (this.#busy) return { ok: false, error: { httpStatus: 429, retryAfterMs: 500, message: "busy" } };
    return {
      ok: true,
      value: {
        revisionId: String(this.#revisionId),
        tabs: [
          { tabId: OWNED_TAB, bodyEndIndex: this.#ownedText.length + 1, paragraphs: this.#ownedParagraphs, childTabs: [] },
          { tabId: FOREIGN_TAB, bodyEndIndex: this.#foreignText.length + 1, paragraphs: [], childTabs: [] },
        ],
      },
    };
  }

  // Reconstructs paragraphs from the request array the same way a real Google
  // Doc would end up storing them, so GoogleDocsNoteSink.read() (and its
  // unchanged-detection in write()) round-trips through this fake honestly
  // rather than through a shortcut only the fake understands.
  async batchUpdate(_documentId: string, requests: readonly unknown[], targetRevisionId?: string): Promise<DocsApiResult<BatchUpdateValue>> {
    if (this.#busy) return { ok: false, error: { httpStatus: 429, retryAfterMs: 500, message: "busy" } };
    if (targetRevisionId !== undefined && targetRevisionId !== String(this.#revisionId)) {
      return { ok: false, error: { httpStatus: 409, message: "stale" } };
    }
    type Req = {
      insertText?: { location: { index: number; tabId?: string }; text: string };
      updateParagraphStyle?: { range: { startIndex: number; endIndex: number; tabId?: string }; paragraphStyle: { namedStyleType: string } };
      createParagraphBullets?: { range: { startIndex: number; endIndex: number; tabId?: string } };
      deleteContentRange?: { range?: { tabId?: string } };
    };
    const typed = requests as readonly Req[];
    const insertText = typed.find((request) => request.insertText)?.insertText;
    const hasDelete = typed.some((request) => request.deleteContentRange !== undefined);
    // Every request in one batch carries the same tabId (buildWriteRequests
    // stamps it via assertHasTabId in src/google/requests.ts) — read it off
    // whichever request happens to be present. This is what gives
    // foreignSnapshot() real teeth: routing by the tabId actually embedded in
    // the requests, rather than always writing into #ownedText, means a
    // regression that ever emitted a request against the wrong tab would
    // land in #foreignText and be observable, instead of being structurally
    // incapable of happening.
    const targetTabId =
      insertText?.location.tabId ??
      typed.find((request) => request.deleteContentRange)?.deleteContentRange?.range?.tabId ??
      typed.find((request) => request.updateParagraphStyle)?.updateParagraphStyle?.range.tabId ??
      typed.find((request) => request.createParagraphBullets)?.createParagraphBullets?.range.tabId;
    if (targetTabId !== undefined && targetTabId !== OWNED_TAB) {
      // A write aimed at any tab other than the owned one: apply it to a
      // genuinely separate slot of state (never touched by the owned-tab
      // logic below) so an ownership-invariant violation would actually
      // change what foreignSnapshot() reports.
      if (insertText !== undefined) this.#foreignText = insertText.text;
      else if (hasDelete) this.#foreignText = "";
      this.#revisionId += 1;
      return { ok: true, value: { revisionId: String(this.#revisionId) } };
    }
    if (insertText === undefined && hasDelete) {
      this.#ownedText = "";
      this.#ownedParagraphs = [];
    }
    if (insertText !== undefined) {
      const baseIndex = insertText.location.index;
      let offset = 0;
      const lines: { text: string; start: number; end: number }[] = [];
      for (const rawLine of insertText.text.split("\n")) {
        const start = baseIndex + offset;
        lines.push({ text: rawLine, start, end: start + rawLine.length });
        offset += rawLine.length + 1;
      }
      const headingRequests = typed.filter((request) => request.updateParagraphStyle);
      const bulletRequests = typed.filter((request) => request.createParagraphBullets);
      this.#ownedParagraphs = lines
        .filter((line) => line.text.length > 0)
        .map((line) => {
          const heading = headingRequests.find((request) => {
            const range = request.updateParagraphStyle!.range;
            return range.startIndex <= line.start && range.endIndex >= line.end;
          });
          const bullet = bulletRequests.some((request) => {
            const range = request.createParagraphBullets!.range;
            return range.startIndex <= line.start && range.endIndex >= line.end;
          });
          const level = heading !== undefined ? NAMED_STYLE_LEVEL[heading.updateParagraphStyle!.paragraphStyle.namedStyleType] : undefined;
          return { text: line.text, ...(level === undefined ? {} : { headingLevel: level }), bullet };
        });
      this.#ownedText = insertText.text;
    }
    this.#revisionId += 1;
    return { ok: true, value: { revisionId: String(this.#revisionId) } };
  }

  mutateExternally(): void { this.#revisionId += 1; }
  makeBusy(): void { this.#busy = true; }
  clearBusy(): void { this.#busy = false; }
  makeMissing(): void { this.#missing = true; }
  makeForbidden(): void { this.#forbidden = true; }
  snapshot(): string { return `${this.#ownedText}|${this.#foreignText}`; }
  foreignSnapshot(): string { return this.#foreignText; }
}

const SECTIONS: readonly Section[] = [{ heading: "Summary", markdown: "First." }];
const ALTERNATE: readonly Section[] = [{ heading: "Decisions", markdown: "Second." }];

describeNoteSinkConformance(
  { describe, test },
  "GoogleDocsNoteSink",
  async (): Promise<SinkHarness> => {
    const api = new FakeDocsApi();
    return {
      sink: new GoogleDocsNoteSink({ documentId: "doc1", tabId: OWNED_TAB, api }),
      sections: SECTIONS,
      alternateSections: ALTERNATE,
      // An empty heading can't be represented as a Docs paragraph
      // parseTabToSections could ever recover a section boundary from
      // (src/google/docs-sink.ts's write() refuses it up front with
      // invalid-content before ever calling the renderer or the fake).
      invalidSections: [{ heading: "", markdown: "x" }],
      mutateExternally: async () => api.mutateExternally(),
      makeBusy: async () => {
        api.makeBusy();
        return async () => api.clearBusy();
      },
      makeMissing: async () => api.makeMissing(),
      makeForbidden: async () => api.makeForbidden(),
      snapshot: () => Promise.resolve(api.snapshot()),
      foreignSnapshot: () => Promise.resolve(api.foreignSnapshot()),
    };
  },
  { missing: true, forbidden: true },
);
