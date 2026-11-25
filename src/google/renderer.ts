import { marked, type Token, type Tokens } from "marked";
import type { Section } from "../note/markers.js";

/** The Docs list style a rendered list block gets. One block is one Docs list. */
export type ListPreset = "bullet" | "numbered" | "checkbox";

export type StyleSpanKind =
  | { kind: "heading"; level: 1 | 2 | 3 }
  /**
   * One whole list block. Its paragraphs carry their nesting as leading tab
   * characters, which `createParagraphBullets` reads and then removes.
   */
  | { kind: "list"; preset: ListPreset }
  | { kind: "bold" }
  | { kind: "italic" }
  | { kind: "strikethrough" }
  | { kind: "link"; url: string };

export type StyleSpan = Readonly<{
  start: number;
  end: number;
  style: StyleSpanKind;
}>;

export type RenderedSections = Readonly<{
  text: string;
  spans: readonly StyleSpan[];
}>;

/** Docs nests lists up to nine levels deep (nesting levels 0 to 8). */
const MAX_LIST_DEPTH = 8;

/** Task markers for a task inside a list that is not all tasks (so not a Docs checklist). */
export const OPEN_TASK_GLYPH = "☐ ";
export const DONE_TASK_GLYPH = "☑ ";

const CALLOUT_MARKER = /^\s*\[![^\]\n]+\][+-]?[ \t]*/;

/**
 * Renders a Section[] (the same {heading, markdown} shape the Markdown sink
 * consumes) into a flat plain-text string plus a list of style spans located
 * by UTF-16 code-unit offset into that string. `requests.ts` turns each span
 * into a Google Docs API request.
 *
 * Supported Markdown, matching the Google Docs presentation the prompt asks for
 * (`GOOGLE_DOCS_PRESENTATION` in `src/agent/contract.ts`): paragraphs, bulleted,
 * numbered and nested lists, task lists (a list of only tasks becomes a Docs
 * checklist, and a done task is struck through), level-three headings, and
 * bold, italic, strikethrough and link runs.
 *
 * Anything else an LLM-produced Section.markdown may contain is degraded rather
 * than thrown on: a blockquote or Obsidian callout keeps its text without the
 * `[!type]` marker, a table becomes a list of rows, code keeps its text, and
 * `==highlight==` and `[[wikilink]]` lose their markers.
 */
export function renderSections(sections: readonly Section[]): RenderedSections {
  const out = new Output();
  for (const section of sections) {
    const headingStart = out.length;
    out.append(section.heading);
    out.spans.push({ start: headingStart, end: out.length, style: { kind: "heading", level: 2 } });
    out.append("\n");
    renderBlocks(marked.lexer(section.markdown), out);
  }
  return { text: out.text, spans: out.spans };
}

class Output {
  text = "";
  readonly spans: StyleSpan[] = [];
  get length(): number {
    return this.text.length;
  }
  append(chunk: string): void {
    this.text += chunk;
  }
  /** Drops everything from `offset` on, with any span that started there. */
  truncate(offset: number): void {
    this.text = this.text.slice(0, offset);
    for (let index = this.spans.length - 1; index >= 0; index -= 1) {
      if (this.spans[index]!.start >= offset) this.spans.splice(index, 1);
    }
  }
}

function renderBlocks(tokens: readonly Token[], out: Output): void {
  for (const token of tokens) renderBlockToken(token, out);
}

function renderBlockToken(token: Token, out: Output): void {
  switch (token.type) {
    case "paragraph":
      renderParagraph((token as Tokens.Paragraph).tokens, out);
      return;
    case "heading": {
      // The host owns levels one and two (each section's own heading), and
      // `parseTabToSections` starts a new section at either, so every heading
      // inside a body is a level-three subsection.
      const start = out.length;
      renderInline((token as Tokens.Heading).tokens, out);
      if (out.length === start) return;
      out.spans.push({ start, end: out.length, style: { kind: "heading", level: 3 } });
      out.append("\n");
      return;
    }
    case "list":
      renderList(token as Tokens.List, out);
      return;
    case "blockquote":
      // Obsidian callouts arrive as blockquotes; keep their content, drop the marker.
      renderBlocks(marked.lexer((token as Tokens.Blockquote).text.replace(CALLOUT_MARKER, "")), out);
      return;
    case "table":
      renderTable(token as Tokens.Table, out);
      return;
    case "code":
      for (const line of (token as Tokens.Code).text.split("\n")) {
        if (line.trim().length === 0) continue;
        out.append(line);
        out.append("\n");
      }
      return;
    // marked emits a "space" token for the blank line between blocks. It
    // carries no content; rendering it would add a spurious empty paragraph on
    // every write and break unchanged-detection idempotence.
    case "space":
    case "hr":
      return;
    default: {
      // Anything else (raw HTML and the like): plain text, and nothing at all
      // when that text is empty, for the same reason as "space" above.
      const flattened = token.raw.replace(/[*_`>#|]/g, "").trim();
      if (flattened.length === 0) return;
      out.append(flattened);
      out.append("\n");
    }
  }
}

function renderParagraph(tokens: readonly Token[] | undefined, out: Output): void {
  const start = out.length;
  renderInline(tokens ?? [], out);
  if (out.length === start) return;
  out.append("\n");
}

function renderList(list: Tokens.List, out: Output): void {
  const items = list.items;
  const allTasks = items.length > 0 && items.every((item) => item.task);
  const preset: ListPreset = allTasks ? "checkbox" : list.ordered ? "numbered" : "bullet";
  const start = out.length;
  renderListItems(items, 0, preset === "checkbox", out);
  if (out.length === start) return;
  out.spans.push({ start, end: out.length, style: { kind: "list", preset } });
}

/**
 * One paragraph per item, prefixed with one tab per nesting level. A nested
 * list (marked emits it inside the item's own tokens) stays inside the same
 * Docs list one level deeper, so it takes the enclosing block's preset.
 */
function renderListItems(
  items: readonly Tokens.ListItem[],
  depth: number,
  checklist: boolean,
  out: Output,
): void {
  for (const item of items) {
    const { inlineTokens, nestedLists } = splitListItemTokens(item.tokens);
    const lineStart = out.length;
    out.append("\t".repeat(Math.min(depth, MAX_LIST_DEPTH)));
    const contentStart = out.length;
    if (item.task && !checklist) out.append(item.checked ? DONE_TASK_GLYPH : OPEN_TASK_GLYPH);
    renderInline(inlineTokens, out);
    if (out.length === contentStart) {
      // An empty item (a stray "* " line) must not leave a paragraph of only
      // tabs: it would be an empty bullet. Its nested lists still render.
      out.truncate(lineStart);
    } else {
      // Docs draws a ticked checkbox struck through; the API cannot tick the
      // box itself, so a done task is struck through to say the same.
      if (item.task && item.checked && checklist) {
        out.spans.push({ start: contentStart, end: out.length, style: { kind: "strikethrough" } });
      }
      out.append("\n");
    }
    for (const nested of nestedLists) renderListItems(nested.items, depth + 1, checklist, out);
  }
}

/** A table becomes a bulleted list with one item per row: "**Header:** cell; ...". */
function renderTable(table: Tokens.Table, out: Output): void {
  const start = out.length;
  for (const row of table.rows) {
    const lineStart = out.length;
    row.forEach((cell, index) => {
      const cellStart = out.length;
      const header = table.header[index];
      if (header !== undefined) renderInline(header.tokens, out);
      const hasLabel = out.length > cellStart;
      const labelEnd = out.length;
      if (hasLabel) out.append(": ");
      const valueStart = out.length;
      renderInline(cell.tokens, out);
      if (out.length === valueStart) {
        out.truncate(cellStart);
        return;
      }
      if (hasLabel) out.spans.push({ start: cellStart, end: labelEnd, style: { kind: "bold" } });
      out.append("; ");
    });
    if (out.length === lineStart) continue;
    out.text = out.text.slice(0, -2);
    out.append("\n");
  }
  if (out.length > start) out.spans.push({ start, end: out.length, style: { kind: "list", preset: "bullet" } });
}

/**
 * Splits a list item's tokens into its own inline content and any nested
 * list(s). Tight lists wrap an item's inline content in a "text" token whose
 * own .tokens holds the real inline tokens; loose lists wrap it in a
 * "paragraph" token instead. Both are unwrapped, or bold and link spans would
 * be lost and their Markdown syntax would leak into the doc. A task item's
 * leading "checkbox" token is dropped; the item's `task`/`checked` carry it.
 */
function splitListItemTokens(
  tokens: readonly Token[],
): { inlineTokens: Token[]; nestedLists: Tokens.List[] } {
  const inlineTokens: Token[] = [];
  const nestedLists: Tokens.List[] = [];
  for (const token of tokens) {
    if (token.type === "checkbox" || token.type === "space") continue;
    if (token.type === "list") {
      nestedLists.push(token as Tokens.List);
      continue;
    }
    // Two paragraphs in one item share its one Docs paragraph.
    if (inlineTokens.length > 0) inlineTokens.push({ type: "text", raw: " ", text: " " } as Tokens.Text);
    if (token.type === "paragraph") {
      inlineTokens.push(...((token as Tokens.Paragraph).tokens ?? []));
    } else if (token.type === "text" && "tokens" in token && token.tokens) {
      inlineTokens.push(...token.tokens);
    } else {
      inlineTokens.push(token);
    }
  }
  return { inlineTokens, nestedLists };
}

const STYLED_INLINE: Readonly<Record<string, StyleSpanKind>> = {
  strong: { kind: "bold" },
  em: { kind: "italic" },
  del: { kind: "strikethrough" },
};

function renderInline(tokens: readonly Token[], out: Output): void {
  for (const token of tokens) {
    const styled = STYLED_INLINE[token.type];
    if (styled !== undefined) {
      const start = out.length;
      renderInline((token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens, out);
      if (out.length > start) out.spans.push({ start, end: out.length, style: styled });
    } else if (token.type === "link") {
      const link = token as Tokens.Link;
      const start = out.length;
      renderInline(link.tokens, out);
      if (out.length > start) out.spans.push({ start, end: out.length, style: { kind: "link", url: link.href } });
    } else if (token.type === "text" && "tokens" in token && token.tokens) {
      renderInline(token.tokens, out);
    } else if (token.type === "text" || token.type === "escape") {
      out.append(cleanText((token as Tokens.Text).text ?? token.raw));
    } else if (token.type === "codespan") {
      out.append((token as Tokens.Codespan).text);
    } else if (token.type === "br") {
      // A newline would end the paragraph (and, in a list, the item).
      out.append(" ");
    } else if (token.type === "image") {
      out.append((token as Tokens.Image).text);
    } else {
      // Any other inline construct (raw HTML and the like): its plain text
      // rather than silently dropping the content.
      out.append(inlineFallbackText(token));
    }
  }
}

/** Drops Obsidian-only inline markers: `==highlight==` and `[[wikilink|alias]]`. */
function cleanText(text: string): string {
  return text
    .replace(/==([^=\n]+)==/g, "$1")
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n]+)\]\]/g, "$1");
}

function inlineFallbackText(token: Token): string {
  const text = (token as { text?: unknown }).text;
  if (typeof text === "string") return text;
  return token.raw.replace(/[*_`>#|~[\]()!]/g, "").trim();
}
