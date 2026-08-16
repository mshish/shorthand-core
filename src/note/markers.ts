export const AI_BLOCK_START = "<!-- handy:ai:start -->";
export const AI_BLOCK_END = "<!-- handy:ai:end -->";
export const USER_NOTES_MARKER = "<!-- handy:notes -->";

export type Section = Readonly<{
  heading: string;
  markdown: string;
}>;

export type MarkerErrorCode =
  | "markers-missing"
  | "start-marker-missing"
  | "end-marker-missing"
  | "duplicate-start-marker"
  | "duplicate-end-marker"
  | "nested-markers"
  | "end-before-start";

export type MarkerError = Readonly<{
  kind: "marker-error";
  code: MarkerErrorCode;
  message: string;
  locations: readonly Readonly<{ offset: number; line: number }>[];
}>;

export type SectionErrorCode =
  | "invalid-section"
  | "empty-heading"
  | "multiline-heading"
  | "marker-in-heading"
  | "marker-in-markdown"
  | "section-heading-in-markdown"
  | "edge-newline-in-markdown";

export type SectionError = Readonly<{
  kind: "section-error";
  code: SectionErrorCode;
  sectionIndex: number;
  message: string;
}>;

export type LocatedBlock = Readonly<{
  bodyStartOffset: number;
  bodyEndOffset: number;
  body: string;
}>;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

type Token = { type: "start" | "end"; offset: number };

function offsetsOf(content: string, token: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while ((offset = content.indexOf(token, offset)) >= 0) {
    offsets.push(offset);
    offset += token.length;
  }
  return offsets;
}

function markerError(code: MarkerErrorCode, content: string, offsets: readonly number[] = []): MarkerError {
  const messages: Record<MarkerErrorCode, string> = {
    "markers-missing": "The note has no Handy AI block markers.",
    "start-marker-missing": "The Handy AI block start marker is missing.",
    "end-marker-missing": "The Handy AI block end marker is missing.",
    "duplicate-start-marker": "The note contains more than one Handy AI block start marker.",
    "duplicate-end-marker": "The note contains more than one Handy AI block end marker.",
    "nested-markers": "The note contains nested Handy AI block markers.",
    "end-before-start": "A Handy AI block end marker appears before its start marker.",
  };
  const locations = offsets.map((offset) => ({
    offset: Buffer.byteLength(content.slice(0, offset), "utf8"),
    line: content.slice(0, offset).split("\n").length,
  }));
  const detail = locations.length === 0
    ? ""
    : ` Offending marker${locations.length === 1 ? "" : "s"}: ${locations.map(({ offset, line }) => `byte ${offset}, line ${line}`).join("; ")}.`;
  return { kind: "marker-error", code, message: `${messages[code]}${detail}`, locations };
}

export function locateAiBlock(content: string): Result<LocatedBlock, MarkerError> {
  const starts = offsetsOf(content, AI_BLOCK_START);
  const ends = offsetsOf(content, AI_BLOCK_END);
  if (starts.length === 0 && ends.length === 0) return { ok: false, error: markerError("markers-missing", content) };
  if (starts.length === 0) return { ok: false, error: markerError("start-marker-missing", content, ends) };
  if (ends.length === 0) return { ok: false, error: markerError("end-marker-missing", content, starts) };

  const tokens: Token[] = [
    ...starts.map((offset): Token => ({ type: "start", offset })),
    ...ends.map((offset): Token => ({ type: "end", offset })),
  ].sort((left, right) => left.offset - right.offset);
  let depth = 0;
  let nested = false;
  for (const token of tokens) {
    if (token.type === "start") {
      depth += 1;
      if (depth > 1) nested = true;
    } else {
      depth -= 1;
    }
  }
  if (nested) return { ok: false, error: markerError("nested-markers", content, starts.slice(1)) };
  if ((ends[0] ?? 0) < (starts[0] ?? 0)) return { ok: false, error: markerError("end-before-start", content, [ends[0]!]) };
  if (starts.length > 1) return { ok: false, error: markerError("duplicate-start-marker", content, starts.slice(1)) };
  if (ends.length > 1) return { ok: false, error: markerError("duplicate-end-marker", content, ends.slice(1)) };

  const startMarkerOffset = starts[0]!;
  const bodyStartOffset = startMarkerOffset + AI_BLOCK_START.length;
  const bodyEndOffset = ends[0]!;
  return {
    ok: true,
    value: {
      bodyStartOffset,
      bodyEndOffset,
      body: content.slice(bodyStartOffset, bodyEndOffset),
    },
  };
}

function containsMarker(value: string): boolean {
  return value.includes(AI_BLOCK_START) || value.includes(AI_BLOCK_END);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n|\r/g, "\n");
}

function fenceAwareHeadingOffsets(value: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  let fence: { character: "`" | "~"; length: number } | undefined;
  for (const line of value.split("\n")) {
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch !== null) {
      const run = fenceMatch[1]!;
      const character = run[0] as "`" | "~";
      if (fence === undefined) {
        fence = { character, length: run.length };
      } else if (character === fence.character && run.length >= fence.length && fenceMatch[2]!.trim() === "") {
        fence = undefined;
      }
    } else if (fence === undefined && /^##(?:\s|$)/.test(line)) {
      offsets.push(offset);
    }
    offset += line.length + 1;
  }
  return offsets;
}

function validateSections(sections: readonly Section[]): Result<readonly Section[], SectionError> {
  for (const [sectionIndex, section] of sections.entries()) {
    if (typeof section?.heading !== "string" || typeof section.markdown !== "string") {
      return sectionFailure("invalid-section", sectionIndex, "Each section must have string heading and markdown fields.");
    }
    if (section.heading.trim().length === 0) {
      return sectionFailure("empty-heading", sectionIndex, "Section headings must not be empty.");
    }
    if (/\r|\n/.test(section.heading)) {
      return sectionFailure("multiline-heading", sectionIndex, "Section headings must fit on one line.");
    }
    if (containsMarker(section.heading)) {
      return sectionFailure("marker-in-heading", sectionIndex, "A section heading contains a Handy marker token.");
    }
    if (containsMarker(section.markdown)) {
      return sectionFailure("marker-in-markdown", sectionIndex, "Section markdown contains a Handy marker token.");
    }
    if (fenceAwareHeadingOffsets(normalizeLineEndings(section.markdown)).length > 0) {
      return sectionFailure("section-heading-in-markdown", sectionIndex, "Section markdown contains a level-two heading that would split the block.");
    }
    if (/^[\r\n]|[\r\n]$/.test(section.markdown)) {
      return sectionFailure("edge-newline-in-markdown", sectionIndex, "Section markdown must not begin or end with a newline.");
    }
  }
  return { ok: true, value: sections };
}

function sectionFailure(code: SectionErrorCode, sectionIndex: number, message: string): Result<never, SectionError> {
  return { ok: false, error: { kind: "section-error", code, sectionIndex, message } };
}

export function renderSections(sections: readonly Section[], lineEnding = "\n"): Result<string, SectionError> {
  const validation = validateSections(sections);
  if (!validation.ok) return validation;
  const rendered = sections.map(({ heading, markdown }) => (
    markdown.length === 0 ? `## ${heading}` : `## ${heading}\n${normalizeLineEndings(markdown)}`
  )).join("\n\n");
  return { ok: true, value: rendered.replaceAll("\n", lineEnding) };
}

export function parseSections(body: string): Result<readonly Section[], SectionError> {
  const normalized = normalizeLineEndings(body).replace(/^\n+|\n+$/g, "");
  if (normalized === "") return { ok: true, value: [] };
  const headings = fenceAwareHeadingOffsets(normalized);
  const chunks: Array<{ heading?: string; markdown: string }> = [];
  if (headings[0] !== 0) {
    const end = headings[0] ?? normalized.length;
    chunks.push({ heading: "Notes", markdown: normalized.slice(0, end).replace(/^\n+|\n+$/g, "") });
  }
  for (const [index, offset] of headings.entries()) {
    const nextOffset = headings[index + 1] ?? normalized.length;
    const chunk = normalized.slice(offset, nextOffset).replace(/^\n+|\n+$/g, "");
    const firstNewline = chunk.indexOf("\n");
    const headingLine = firstNewline < 0 ? chunk : chunk.slice(0, firstNewline);
    chunks.push({
      heading: headingLine.slice(3).trim(),
      markdown: (firstNewline < 0 ? "" : chunk.slice(firstNewline + 1)).replace(/^\n+|\n+$/g, ""),
    });
  }
  const sections: Section[] = [];
  for (const [sectionIndex, chunk] of chunks.entries()) {
    if (chunk.heading === undefined || chunk.heading.length === 0) {
      return sectionFailure("empty-heading", sectionIndex, "The block body must consist of level-two sections.");
    }
    sections.push({ heading: chunk.heading, markdown: chunk.markdown });
  }
  return validateSections(sections);
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const firstNewline = content.indexOf("\n");
  return firstNewline > 0 && content[firstNewline - 1] === "\r" ? "\r\n" : "\n";
}

export function transcriptWikilink(content: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (frontmatter === undefined) return undefined;
  return /^handy-transcript:\s*["']?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]["']?\s*$/m.exec(frontmatter)?.[1];
}

export type NoteScaffoldOptions = Readonly<{
  captureTimestamp: string;
  transcriptWikilink: string;
  title: string;
  sections: readonly Section[];
  lineEnding?: "\r\n" | "\n";
}>;

export function buildNoteScaffold(options: NoteScaffoldOptions): Result<string, SectionError> {
  if (containsMarker(options.title)) {
    return sectionFailure("marker-in-heading", -1, "The note title contains a Handy marker token.");
  }
  if (containsMarker(options.transcriptWikilink)) {
    return sectionFailure("marker-in-markdown", -1, "The transcript link contains a Handy marker token.");
  }
  const lineEnding = options.lineEnding ?? "\n";
  const rendered = renderSections(options.sections, lineEnding);
  if (!rendered.ok) return rendered;
  const yamlLink = options.transcriptWikilink.replaceAll("\\", "/").replace(/\.md$/i, "").replaceAll('"', '\\"');
  const safeTitle = options.title.replace(/[\r\n]+/g, " ").trim();
  const body = rendered.value.length === 0 ? lineEnding : `${lineEnding}${rendered.value}${lineEnding}`;
  return {
    ok: true,
    value: [
      "---",
      `handy-capture: ${options.captureTimestamp}`,
      `handy-transcript: "[[${yamlLink}]]"`,
      "---",
      `# ${safeTitle}`,
      "",
      USER_NOTES_MARKER,
      "",
      AI_BLOCK_START + body + AI_BLOCK_END,
      "",
    ].join(lineEnding),
  };
}

/**
 * Adds the ownership scaffold to an existing note without changing any existing
 * bytes. Persistence is deliberately handled by note/writer.ts so callers keep
 * the same locking, stale-read, and atomic-replace guarantees as AI writes.
 */
export function appendNoteScaffold(
  content: string,
  sections: readonly Section[],
): Result<string, MarkerError | SectionError> {
  const located = locateAiBlock(content);
  if (located.ok) return { ok: true, value: content };
  if (located.error.code !== "markers-missing") return located;

  const lineEnding = detectLineEnding(content);
  const rendered = renderSections(sections, lineEnding);
  if (!rendered.ok) return rendered;
  const separator = content.length === 0
    ? ""
    : content.endsWith("\n") || content.endsWith("\r")
      ? lineEnding
      : `${lineEnding}${lineEnding}`;
  const notesMarker = content.includes(USER_NOTES_MARKER)
    ? ""
    : `${USER_NOTES_MARKER}${lineEnding}${lineEnding}`;
  const body = rendered.value.length === 0 ? lineEnding : `${lineEnding}${rendered.value}${lineEnding}`;
  return {
    ok: true,
    value: `${content}${separator}${notesMarker}${AI_BLOCK_START}${body}${AI_BLOCK_END}${lineEnding}`,
  };
}
