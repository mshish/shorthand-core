/**
 * The Markdown reference implementation of the sink port, plus the note
 * scaffolding helpers a Markdown-app consumer genuinely needs.
 *
 * It stays in core behind this subpath rather than becoming its own package:
 * a second, API-backed sink will not import it, and tree-shaking handles the
 * dead weight. The document codec is public because editor-backed consumers
 * need the same parser, revision, and exact-splice rules without going through
 * the filesystem. Lower-level hashes, parsers, and markers stay private.
 */

export { MarkdownNoteSink } from "./note/markdown-sink.js";
export type { MarkdownNoteSinkOptions } from "./note/markdown-sink.js";

export {
  readMarkdownDocument,
  scaffoldMarkdownDocument,
  updateMarkdownDocument,
} from "./note/markdown-document.js";
export type {
  MarkdownDocumentScaffoldResult,
  MarkdownDocumentUpdateResult,
  MarkdownTextEdit,
} from "./note/markdown-document.js";

export { buildNoteScaffold, locateAiBlock, transcriptWikilink } from "./note/markers.js";
export type { LocatedBlock, MarkerError, NoteScaffoldOptions } from "./note/markers.js";

export { ensureNoteScaffold, linkTranscriptFrontmatter } from "./note/writer.js";
export type { EnsureScaffoldResult, LinkTranscriptResult } from "./note/writer.js";
