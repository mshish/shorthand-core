import { marked, type Token, type Tokens } from "marked";
import type { Section } from "../note/markers.js";

export type StyleSpanKind =
  | { kind: "heading"; level: 1 | 2 | 3 }
  | { kind: "bullet" }
  | { kind: "bold" }
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

/**
 * Renders a Section[] (the same {heading, markdown} shape the Markdown sink
 * consumes) into a flat plain-text string plus a list of style spans located
 * by UTF-16 code-unit offset into that string. Downstream (Task 4) turns each
 * span into a Google Docs API style request.
 *
 * Supported markdown subset: paragraphs, one-level `- `/`* ` bullet lists,
 * `**bold**` runs, and `[text](url)` links — matching exactly what the spec
 * calls out. Anything else marked can produce inside a section body (nested
 * heading, code block, blockquote, table, image) is defensively flattened to
 * plain text rather than thrown on, since nothing constrains what an
 * LLM-produced Section.markdown may contain.
 */
export function renderSections(sections: readonly Section[]): RenderedSections {
  let text = "";
  const spans: StyleSpan[] = [];
  const append = (chunk: string): void => {
    text += chunk;
  };
  const currentLength = (): number => text.length;

  for (const section of sections) {
    const headingStart = currentLength();
    append(section.heading);
    spans.push({ start: headingStart, end: currentLength(), style: { kind: "heading", level: 2 } });
    append("\n");

    for (const token of marked.lexer(section.markdown)) {
      renderBlockToken(token, append, currentLength, spans);
    }
  }

  return { text, spans };
}

function renderBlockToken(
  token: Token,
  append: (chunk: string) => void,
  currentLength: () => number,
  spans: StyleSpan[],
): void {
  if (token.type === "paragraph") {
    renderInline((token as Tokens.Paragraph).tokens, append, currentLength, spans);
    append("\n");
    return;
  }
  if (token.type === "list") {
    for (const item of (token as Tokens.List).items) {
      const bulletStart = currentLength();
      renderInline(item.tokens.flatMap(extractInline), append, currentLength, spans);
      spans.push({ start: bulletStart, end: currentLength(), style: { kind: "bullet" } });
      append("\n");
    }
    return;
  }
  // Anything else (heading inside a section body, code, blockquote, table, image):
  // fall back to plain text so an unexpected LLM-produced construct never throws.
  append(token.raw.replace(/[*_`>#|]/g, "").trim());
  append("\n");
}

/** Unwraps a list item's leading "text" wrapper token to its inline contents. */
function extractInline(token: Token): Token[] {
  if (token.type === "text" && "tokens" in token && token.tokens) return token.tokens;
  return [token];
}

function renderInline(
  tokens: readonly Token[],
  append: (chunk: string) => void,
  currentLength: () => number,
  spans: StyleSpan[],
): void {
  for (const token of tokens) {
    if (token.type === "strong") {
      const strong = token as Tokens.Strong;
      const start = currentLength();
      renderInline(strong.tokens, append, currentLength, spans);
      spans.push({ start, end: currentLength(), style: { kind: "bold" } });
    } else if (token.type === "link") {
      const link = token as Tokens.Link;
      const start = currentLength();
      renderInline(link.tokens, append, currentLength, spans);
      spans.push({ start, end: currentLength(), style: { kind: "link", url: link.href } });
    } else if (token.type === "text" || token.type === "codespan" || token.type === "em") {
      append((token as Tokens.Text | Tokens.Codespan | Tokens.Em).text ?? token.raw);
    }
  }
}
