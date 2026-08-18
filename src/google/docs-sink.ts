import { renderSections } from "./renderer.js";
import { buildWriteRequests } from "./requests.js";
import type { DocsApiError, DocsTab, GoogleDocsApi } from "./docs-client.js";
import type { Section } from "../note/markers.js";
import { busySinkError, sinkError, type NoteSink, type SinkError, type SinkReadResult, type SinkWriteResult } from "../note/sink.js";

export const GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type GoogleDocsNoteSinkOptions = Readonly<{
  documentId: string;
  tabId: string;
  api: GoogleDocsApi;
  describe?: string;
}>;

/**
 * The Google Docs `NoteSink`: an AI-owned tab inside a shared Doc, addressed
 * by `tabId` (never by position — tabs can be reordered by a human at any
 * time). No `agentContext` is ever set: the spec's "Explicitly out of scope"
 * and `docs/CONTRACT.md` §2.4 agree that an API sink has no vault to offer.
 */
export class GoogleDocsNoteSink implements NoteSink {
  // Declared but never assigned: an API sink has no vault to offer (see the
  // class doc comment), so this always reads as undefined — but the field
  // must exist on the class for `sink.agentContext` to typecheck at all.
  readonly agentContext?: { cwd: string };
  readonly describe: string;
  readonly #documentId: string;
  readonly #tabId: string;
  readonly #api: GoogleDocsApi;

  constructor(options: GoogleDocsNoteSinkOptions) {
    this.#documentId = options.documentId;
    this.#tabId = options.tabId;
    this.#api = options.api;
    this.describe = options.describe ?? `Google Doc ${options.documentId} (tab ${options.tabId})`;
  }

  async read(): Promise<SinkReadResult> {
    const result = await this.#api.getDocument(this.#documentId);
    if (!result.ok) return { ok: false, error: readErrorFor(result.error) };
    const tab = findTab(result.value.tabs, this.#tabId);
    if (tab === undefined) {
      return { ok: false, error: sinkError("invalid-target", `Tab ${this.#tabId} not found in document ${this.#documentId}`) };
    }
    return { ok: true, value: { sections: parseTabToSections(tab), userNotes: "", revision: result.value.revisionId } };
  }

  async write(sections: readonly Section[], expectedRevision: string): Promise<SinkWriteResult> {
    const read = await this.#api.getDocument(this.#documentId);
    if (!read.ok) return writeErrorFor(read.error);
    const tab = findTab(read.value.tabs, this.#tabId);
    if (tab === undefined) {
      return { status: "error", error: sinkError("invalid-target", `Tab ${this.#tabId} not found in document ${this.#documentId}`) };
    }
    const { text, spans } = renderSections(sections);
    // Stale outranks equality (docs/CONTRACT.md §2.2): only short-circuit to
    // "unchanged" when the caller's revision still matches what's stored now.
    // Comparing both sides through the same renderer means the lossy Docs
    // round-trip (parseTabToSections drops markdown syntax) never causes a
    // false "changed" — whatever fidelity is lost is lost identically on both
    // operands.
    if (read.value.revisionId === expectedRevision && text === renderSections(parseTabToSections(tab)).text) {
      return { status: "unchanged", revision: read.value.revisionId };
    }
    const requests = buildWriteRequests({ tabId: this.#tabId, bodyEndIndex: tab.bodyEndIndex, text, spans });
    const result = await this.#api.batchUpdate(this.#documentId, requests, expectedRevision);
    if (!result.ok) return writeErrorFor(result.error);
    return { status: "written", revision: result.value.revisionId };
  }
}

/**
 * Lossy on purpose: reconstructs headings/paragraphs/bullets from what read()
 * saw so EnhanceRunner has prior sections to revise and to check `.length > 0`
 * against (src/agent/runner.ts:213-220) — it does not reconstruct bold/link
 * markdown syntax from Docs text-run styling, since core only ever consumes
 * the reconstructed sections as prompt context, not as bytes it round-trips.
 */
function parseTabToSections(tab: DocsTab): readonly Section[] {
  const sections: Section[] = [];
  let current: { heading: string; lines: string[] } | undefined;
  for (const paragraph of tab.paragraphs) {
    if (paragraph.headingLevel !== undefined) {
      if (current !== undefined) sections.push({ heading: current.heading, markdown: current.lines.join("\n") });
      current = { heading: paragraph.text, lines: [] };
      continue;
    }
    if (current === undefined) continue;
    current.lines.push(paragraph.bullet ? `- ${paragraph.text}` : paragraph.text);
  }
  if (current !== undefined) sections.push({ heading: current.heading, markdown: current.lines.join("\n") });
  return sections;
}

function findTab(tabs: readonly DocsTab[], tabId: string): DocsTab | undefined {
  for (const tab of tabs) {
    if (tab.tabId === tabId) return tab;
    const found = findTab(tab.childTabs, tabId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readErrorFor(error: DocsApiError): SinkError {
  if (error.httpStatus === 404) return sinkError("not-found", error.message);
  if (error.httpStatus === 401 || error.httpStatus === 403) return sinkError("forbidden", error.message);
  if (error.httpStatus === 429) return busySinkError(error.message, error.retryAfterMs);
  return sinkError("transport", error.message);
}

function writeErrorFor(error: DocsApiError): SinkWriteResult {
  if (error.httpStatus === 409 || error.httpStatus === 412) return { status: "stale" };
  if (error.httpStatus === 429) return { status: "busy", ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) };
  if (error.httpStatus === 404) return { status: "error", error: sinkError("not-found", error.message) };
  if (error.httpStatus === 401 || error.httpStatus === 403) return { status: "error", error: sinkError("forbidden", error.message) };
  return { status: "error", error: sinkError("transport", error.message) };
}
