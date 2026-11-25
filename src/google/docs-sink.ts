import { renderSections } from "./renderer.js";
import { buildWriteRequests } from "./requests.js";
import type { DocsApiError, DocsParagraph, DocsTab, GoogleDocsApi } from "./docs-client.js";
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
  /** Google Docs shows only what `renderer.ts` converts, so the prompt asks for that subset. */
  readonly noteFormat = "google-docs" as const;
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
    // A blank heading can't be represented as a Docs paragraph that
    // parseTabToSections could ever recover a section boundary from (its
    // section detection is a level-one or level-two heading, not text content),
    // so refuse it here rather than silently rendering an empty title.
    const blankHeading = sections.find((section) => section.heading.trim().length === 0);
    if (blankHeading !== undefined) {
      return { status: "error", error: sinkError("invalid-content", "Section heading must not be empty") };
    }
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
    // operands. This compares .text only, not .spans: a revision that changes
    // only inline styling (e.g. adding **bold** around text that renders the
    // same) is indistinguishable here and reports unchanged. That's the same
    // lossy round-trip as Ruling 2 (parseTabToSections can't recover prior
    // styling to compare against), not a separate gap.
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
 * Reconstructs the sections from what read() saw, as Markdown in the subset
 * `renderer.ts` writes: level-one and level-two headings start sections,
 * level-three headings stay inside them, and lists keep their nesting, kind and
 * ticked state, and paragraphs their bold, italic, strikethrough and link runs.
 * The agent revises these on its next pass, so a list that came back as plain
 * bullets would lose its checklist or numbering one pass later.
 *
 * Blocks are separated by a blank line and list items by a single newline, so
 * a paragraph after a list never reads as a continuation of its last item.
 */
function parseTabToSections(tab: DocsTab): readonly Section[] {
  const sections: Section[] = [];
  let current: { heading: string; markdown: string; lastWasList: boolean } | undefined;
  const flush = (): void => {
    if (current !== undefined) sections.push({ heading: current.heading, markdown: current.markdown });
  };
  for (const paragraph of tab.paragraphs) {
    if (paragraph.headingLevel === 1 || paragraph.headingLevel === 2) {
      flush();
      current = { heading: paragraph.text, markdown: "", lastWasList: false };
      continue;
    }
    if (current === undefined) continue;
    const content = paragraph.markdown ?? paragraph.text;
    const isList = paragraph.bullet;
    const line = paragraph.headingLevel === 3
      ? `### ${content}`
      : isList ? `${"    ".repeat(paragraph.nestingLevel ?? 0)}${listMarker(paragraph)}${content}` : content;
    const separator = current.markdown.length === 0 ? "" : isList && current.lastWasList ? "\n" : "\n\n";
    current.markdown += separator + line;
    current.lastWasList = isList;
  }
  flush();
  return sections;
}

function listMarker(paragraph: DocsParagraph): string {
  if (paragraph.listKind === "numbered") return "1. ";
  if (paragraph.listKind === "checkbox") return paragraph.checked === true ? "* [x] " : "* [ ] ";
  return "* ";
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
  if (error.httpStatus === 404) return sinkError("not-found", error.message, error.cause);
  if (error.httpStatus === 401 || error.httpStatus === 403) return sinkError("forbidden", error.message, error.cause);
  // 503 (backend overload) is transient exactly like 429 (docs/CONTRACT.md §4:
  // "503 with Retry-After is busy, not transport") — core must re-queue it
  // cheaply rather than counting it as a permanent failure.
  if (error.httpStatus === 429 || error.httpStatus === 503) return busySinkError(error.message, error.retryAfterMs, error.cause);
  return sinkError("transport", error.message, error.cause);
}

function writeErrorFor(error: DocsApiError): SinkWriteResult {
  // The real Google Docs API returns 400 (not 409/412) for a targetRevisionId
  // conflict (see Schema$WriteControl's doc comment in the googleapis types,
  // and this feature's spec's "Concurrency" section: "Treat the resulting 400
  // ... as an expected, retryable condition"). 400 is technically overloaded
  // with "malformed request" too, but buildWriteRequests is the sole source of
  // requests here, so a malformed request would be a bug worth surfacing as a
  // retry-then-fail rather than a special case.
  if (error.httpStatus === 409 || error.httpStatus === 412 || error.httpStatus === 400) return { status: "stale" };
  // See the matching comment in readErrorFor: 503 is treated identically to 429.
  if (error.httpStatus === 429 || error.httpStatus === 503) {
    return { status: "busy", ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) };
  }
  if (error.httpStatus === 404) return { status: "error", error: sinkError("not-found", error.message, error.cause) };
  if (error.httpStatus === 401 || error.httpStatus === 403) return { status: "error", error: sinkError("forbidden", error.message, error.cause) };
  return { status: "error", error: sinkError("transport", error.message, error.cause) };
}
