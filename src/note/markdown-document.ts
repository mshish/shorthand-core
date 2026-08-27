import {
  AI_BLOCK_START,
  USER_NOTES_MARKER,
  appendNoteScaffold,
  detectLineEnding,
  locateAiBlock,
  parseSections,
  renderSections,
  type MarkerError,
  type Section,
  type SectionError,
} from "./markers.js";
import { hashBlock } from "./markdown-revision.js";
import { sinkError, type SinkError, type SinkReadResult } from "./sink.js";

export type MarkdownTextEdit = Readonly<{
  from: number;
  to: number;
  replacement: string;
}>;

export type MarkdownDocumentUpdateResult =
  | Readonly<{ status: "written"; content: string; edit: MarkdownTextEdit; revision: string }>
  | Readonly<{ status: "unchanged"; revision: string }>
  | Readonly<{ status: "stale"; actualRevision: string }>
  | Readonly<{ status: "error"; error: SinkError }>;

export type MarkdownDocumentScaffoldResult =
  | Readonly<{ status: "written"; content: string; edit: MarkdownTextEdit }>
  | Readonly<{ status: "unchanged" }>
  | Readonly<{ status: "error"; error: SinkError }>;

/**
 * Decode one observation of a Markdown note into the transport-neutral sink
 * snapshot. Keeping this synchronous lets an Obsidian adapter use the exact
 * same rules for an Editor buffer and inside Vault.process().
 */
export function readMarkdownDocument(content: string): SinkReadResult {
  const located = locateAiBlock(content);
  if (!located.ok) return { ok: false, error: markdownError(located.error) };
  const parsed = parseSections(located.value.body);
  if (!parsed.ok) return { ok: false, error: markdownError(parsed.error) };
  return {
    ok: true,
    value: {
      sections: parsed.value,
      userNotes: extractUserNotes(content),
      revision: hashBlock(located.value.body),
    },
  };
}

/**
 * Produce both the complete next document for an atomic document API and the
 * exact owned-range edit for a live editor. No bytes outside the AI block are
 * included in the edit.
 */
export function updateMarkdownDocument(
  content: string,
  sections: readonly Section[],
  expectedRevision: string,
): MarkdownDocumentUpdateResult {
  let rendered: ReturnType<typeof renderSections>;
  try {
    rendered = renderSections(sections, detectLineEnding(content));
  } catch (error) {
    return { status: "error", error: invalidSectionsError(error) };
  }
  if (!rendered.ok) return { status: "error", error: markdownError(rendered.error) };

  const located = locateAiBlock(content);
  if (!located.ok) return { status: "error", error: markdownError(located.error) };
  const actualRevision = hashBlock(located.value.body);
  if (actualRevision !== expectedRevision) return { status: "stale", actualRevision };

  const lineEnding = detectLineEnding(content);
  const replacement = rendered.value.length === 0
    ? lineEnding
    : `${lineEnding}${rendered.value}${lineEnding}`;
  const edit = {
    from: located.value.bodyStartOffset,
    to: located.value.bodyEndOffset,
    replacement,
  } as const;
  const updated = content.slice(0, edit.from) + edit.replacement + content.slice(edit.to);
  if (updated === content) return { status: "unchanged", revision: actualRevision };
  return {
    status: "written",
    content: updated,
    edit,
    revision: hashBlock(replacement),
  };
}

/** Add the ownership scaffold without changing any existing byte. */
export function scaffoldMarkdownDocument(
  content: string,
  sections: readonly Section[],
): MarkdownDocumentScaffoldResult {
  let updated: ReturnType<typeof appendNoteScaffold>;
  try {
    updated = appendNoteScaffold(content, sections);
  } catch (error) {
    return { status: "error", error: invalidSectionsError(error) };
  }
  if (!updated.ok) return { status: "error", error: markdownError(updated.error) };
  if (updated.value === content) return { status: "unchanged" };
  return {
    status: "written",
    content: updated.value,
    edit: { from: content.length, to: content.length, replacement: updated.value.slice(content.length) },
  };
}

/** The user-owned prose between the notes marker and the AI block. */
export function extractUserNotes(noteContent: string): string {
  const notesStart = noteContent.indexOf(USER_NOTES_MARKER);
  const aiStart = noteContent.indexOf(AI_BLOCK_START);
  if (notesStart < 0 || aiStart < notesStart) return "";
  return noteContent.slice(notesStart + USER_NOTES_MARKER.length, aiStart).replace(/^\s+|\s+$/g, "");
}

function markdownError(error: MarkerError | SectionError): SinkError {
  return sinkError(error.kind === "marker-error" ? "invalid-target" : "invalid-content", error.message, error);
}

function invalidSectionsError(cause: unknown): SinkError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  const error: SectionError = {
    kind: "section-error",
    code: "invalid-section",
    sectionIndex: -1,
    message: `Invalid sections input${detail}`,
  };
  return sinkError("invalid-content", error.message, error);
}
