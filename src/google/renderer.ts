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
    renderListItems((token as Tokens.List).items, append, currentLength, spans);
    return;
  }
  // marked emits a "space" token for the blank line between block-level
  // tokens (e.g. the paragraph break in "One.\n\nTwo."). It carries no
  // content of its own; running it through the generic fallback below used
  // to append a spurious empty paragraph on every render, which broke
  // unchanged-detection idempotence for any multi-paragraph section body.
  if (token.type === "space") return;
  // Anything else (heading inside a section body, code, blockquote, table, image):
  // fall back to plain text so an unexpected LLM-produced construct never throws.
  // Skip appending anything (not even a trailing newline) when the flattened
  // text is empty, for the same reason as the "space" token above: an empty
  // fallback must never manifest as a spurious blank paragraph.
  const flattened = token.raw.replace(/[*_`>#|]/g, "").trim();
  if (flattened.length === 0) return;
  append(flattened);
  append("\n");
}

/**
 * Renders each list item as its own bullet span. A nested list inside an
 * item (marked emits it as a sibling "list" token within item.tokens, next
 * to the item's own text/paragraph wrapper — see splitListItemTokens) is
 * flattened to additional same-level bullets rather than indented, per the
 * brief's "nested lists render as bullets at the same level" scope.
 */
function renderListItems(
  items: readonly Tokens.ListItem[],
  append: (chunk: string) => void,
  currentLength: () => number,
  spans: StyleSpan[],
): void {
  for (const item of items) {
    const { inlineTokens, nestedLists } = splitListItemTokens(item.tokens);

    const bulletStart = currentLength();
    renderInline(inlineTokens, append, currentLength, spans);
    // An empty item (e.g. a stray "- " line with no text) must not produce a
    // zero-length bullet span: buildWriteRequests would turn that into a
    // degenerate startIndex === endIndex createParagraphBullets request,
    // which the real Docs API rejects with a 400 that fails the whole
    // (atomic) batchUpdate. Nested lists under an otherwise-empty item still
    // render, so a bullet with only a sub-list is not silently dropped.
    if (currentLength() > bulletStart) {
      spans.push({ start: bulletStart, end: currentLength(), style: { kind: "bullet" } });
      append("\n");
    }

    for (const nestedList of nestedLists) {
      renderListItems(nestedList.items, append, currentLength, spans);
    }
  }
}

/**
 * Splits a list item's tokens into its own inline content and any nested
 * list(s). Tight lists wrap an item's inline content in a "text" token whose
 * own .tokens holds the real inline tokens; loose lists (a blank line
 * between `- ` items) wrap it in a full "paragraph" token instead. Both need
 * unwrapping to reach the actual strong/link/text tokens — falling back to
 * the wrapper's raw/verbatim text (as a naive single-token fallback would)
 * loses bold/link spans and leaks `**`/`[]()` markdown syntax into the
 * output.
 */
function splitListItemTokens(
  tokens: readonly Token[],
): { inlineTokens: Token[]; nestedLists: Tokens.List[] } {
  const inlineTokens: Token[] = [];
  const nestedLists: Tokens.List[] = [];
  for (const token of tokens) {
    if (token.type === "list") {
      nestedLists.push(token as Tokens.List);
    } else if (token.type === "paragraph") {
      inlineTokens.push(...((token as Tokens.Paragraph).tokens ?? []));
    } else if (token.type === "text" && "tokens" in token && token.tokens) {
      inlineTokens.push(...token.tokens);
    } else {
      inlineTokens.push(token);
    }
  }
  return { inlineTokens, nestedLists };
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
    } else {
      // Any other inline construct (image, strikethrough, escape, raw HTML, etc.):
      // fall back to its plain text rather than silently dropping the content.
      append(inlineFallbackText(token));
    }
  }
}

function inlineFallbackText(token: Token): string {
  const text = (token as { text?: unknown }).text;
  if (typeof text === "string") return text;
  return token.raw.replace(/[*_`>#|~[\]()!]/g, "").trim();
}
