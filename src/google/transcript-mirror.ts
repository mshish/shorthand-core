import type { Section } from "../note/markers.js";
import { SIDECAR_SENTINEL } from "../note/sidecar.js";
import { resolveCaptureTarget, writeCaptureState, type ResolveGoogleSinkOptions } from "./capture-sink.js";
import type { DocsApiError, DocsTab, GoogleDocsApi } from "./docs-client.js";
import { renderSections } from "./renderer.js";
import { buildWriteRequests } from "./requests.js";

/**
 * Mirrors a capture's transcript sidecar into its own Google Docs tab, for hosts that
 * keep a transcript alongside the notes (the Shorthand app's Meeting mode "save
 * transcripts" setting). The sidecar file stays the source of truth; the tab is a
 * read-only copy, rewritten whole on each push.
 *
 * Where the tab goes follows the notes: with a shared document (a tab per meeting) it is
 * a child tab named "Transcript" under that meeting's tab, and with a meeting's own
 * document (`--google-document`) it is a top-level "Transcript" tab beside the notes.
 * Its id is kept in the same `captures/<id>.json` state as the notes tab, so a resumed
 * capture keeps writing the same tab.
 */

export const TRANSCRIPT_TAB_TITLE = "Transcript";

export type ResolveGoogleTranscriptMirrorOptions = ResolveGoogleSinkOptions & Readonly<{
  /** How long to wait after a change before pushing it. Default 10s. */
  intervalMs?: number;
  /** Told about a failed push. The next change, or close(), tries again. */
  onError?: (message: string) => void;
}>;

export type ResolveGoogleTranscriptMirrorResult =
  | Readonly<{ ok: true; mirror: GoogleTranscriptMirror }>
  | Readonly<{ ok: false; message: string }>;

export async function resolveGoogleTranscriptMirror(
  notePath: string,
  environment: NodeJS.ProcessEnv,
  options: ResolveGoogleTranscriptMirrorOptions = {},
): Promise<ResolveGoogleTranscriptMirrorResult> {
  const resolved = await resolveCaptureTarget(notePath, environment, options);
  if (!resolved.ok) return resolved;
  const { documentId, tabId: notesTabId, ownDocument, api, statePath, state } = resolved.target;

  const read = await api.getDocument(documentId);
  if (!read.ok) return { ok: false, message: `Could not open the Google Doc for the transcript: ${read.error.message}` };

  let transcriptTabId = state.transcriptTabId;
  if (transcriptTabId !== undefined && findTab(read.value.tabs, transcriptTabId) === undefined) {
    // Deleted from inside the doc; mint a new one rather than failing every push.
    transcriptTabId = undefined;
  }
  if (transcriptTabId === undefined) {
    const minted = await api.addDocumentTab(
      documentId,
      TRANSCRIPT_TAB_TITLE,
      ownDocument ? {} : { parentTabId: notesTabId },
    );
    if (!minted.ok) return { ok: false, message: `Could not create the transcript tab: ${minted.error.message}` };
    transcriptTabId = minted.value.tabId;
    await writeCaptureState(statePath, { ...state, transcriptTabId });
  }

  return {
    ok: true,
    mirror: new GoogleTranscriptMirror({
      api,
      documentId,
      tabId: transcriptTabId,
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    }),
  };
}

const DEFAULT_INTERVAL_MS = 10_000;

type MirrorOptions = Readonly<{
  api: GoogleDocsApi;
  documentId: string;
  tabId: string;
  intervalMs: number;
  onError?: (message: string) => void;
}>;

export class GoogleTranscriptMirror {
  readonly #options: MirrorOptions;
  #latest: string | undefined;
  #pushed: string | undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: MirrorOptions) {
    this.#options = options;
  }

  get tabId(): string {
    return this.#options.tabId;
  }

  /** The sidecar's full text after a write. Pushed at most once per interval. */
  offer(sidecarContent: string): void {
    if (this.#closed) return;
    this.#latest = sidecarContent;
    if (this.#timer !== null || this.#latest === this.#pushed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#chain = this.#chain.then(() => this.#push());
    }, this.#options.intervalMs);
  }

  /** Pushes whatever is still unsent, then stops taking offers. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#chain = this.#chain.then(() => this.#push());
    await this.#chain;
  }

  async #push(): Promise<void> {
    const content = this.#latest;
    if (content === undefined || content === this.#pushed) return;
    const { api, documentId, tabId } = this.#options;
    const read = await api.getDocument(documentId);
    if (!read.ok) return this.#fail(read.error);
    const tab = findTab(read.value.tabs, tabId);
    if (tab === undefined) {
      this.#options.onError?.(`The transcript tab is no longer in Google Doc ${documentId}.`);
      return;
    }
    const { text, spans } = renderSections(transcriptSections(content));
    const requests = buildWriteRequests({ tabId, bodyEndIndex: tab.bodyEndIndex, text, spans });
    if (requests.length > 0) {
      // No writeControl: this tab is Shorthand's alone and is rewritten whole, so a
      // concurrent edit elsewhere in the doc (the notes tab, say) is no conflict.
      const written = await api.batchUpdate(documentId, requests);
      if (!written.ok) return this.#fail(written.error);
    }
    this.#pushed = content;
  }

  #fail(error: DocsApiError): void {
    this.#options.onError?.(`Could not update the transcript tab: ${error.message}`);
    // Try again on the next interval rather than waiting for the next change, which may
    // never come once the meeting has gone quiet.
    if (!this.#closed && this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#chain = this.#chain.then(() => this.#push());
      }, error.retryAfterMs ?? this.#options.intervalMs);
    }
  }
}

/**
 * The sidecar's Markdown as sections for the Docs renderer: one per `## ` heading
 * (connection and session, or a resume marker), with the file's own header and its
 * Obsidian callout syntax dropped, since Docs shows neither.
 */
export function transcriptSections(sidecarContent: string): readonly Section[] {
  const sections: Section[] = [];
  let current: { heading: string; lines: string[] } | undefined;
  for (const line of sidecarContent.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      if (current !== undefined) sections.push(toSection(current));
      current = { heading: line.slice(3).trim(), lines: [] };
      continue;
    }
    if (current === undefined) continue;
    current.lines.push(plainLine(line));
  }
  if (current !== undefined) sections.push(toSection(current));
  return sections;
}

function toSection(current: { heading: string; lines: string[] }): Section {
  return { heading: current.heading, markdown: current.lines.join("\n").trim() };
}

function plainLine(line: string): string {
  if (line === SIDECAR_SENTINEL) return "";
  const callout = /^>\s*\[![^\]]+\]\s*(.*)$/.exec(line);
  if (callout !== null) return callout[1] === undefined || callout[1].length === 0 ? "" : `**${callout[1]}**`;
  if (line.startsWith(">")) return line.replace(/^>\s?/, "");
  return line;
}

function findTab(tabs: readonly DocsTab[], tabId: string): DocsTab | undefined {
  for (const tab of tabs) {
    if (tab.tabId === tabId) return tab;
    const found = findTab(tab.childTabs, tabId);
    if (found !== undefined) return found;
  }
  return undefined;
}
