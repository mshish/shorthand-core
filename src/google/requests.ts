// See src/google/docs-client.ts for why this is the per-API package, not "googleapis".
import type { docs_v1 } from "@googleapis/docs";
import type { ListPreset, StyleSpan } from "./renderer.js";

export type BuildWriteRequestsOptions = Readonly<{
  tabId: string;
  bodyEndIndex: number;
  text: string;
  spans: readonly StyleSpan[];
}>;

const NAMED_STYLE_BY_LEVEL: Record<1 | 2 | 3, string> = {
  1: "HEADING_1",
  2: "HEADING_2",
  3: "HEADING_3",
};

const BULLET_PRESET: Record<ListPreset, string> = {
  bullet: "BULLET_DISC_CIRCLE_SQUARE",
  numbered: "NUMBERED_DECIMAL_ALPHA_ROMAN",
  checkbox: "BULLET_CHECKBOX",
};

/**
 * Delete, insert, style, then make lists, in that literal order: style
 * requests target offsets within the text insertText is about to create, so
 * they cannot run before it.
 *
 * `createParagraphBullets` reads each paragraph's nesting from its leading tabs
 * and then deletes those tabs, which shifts every later index. So the list
 * requests run last, from the end of the text backwards: each one only moves
 * text after it, which no remaining request touches, and the styles applied
 * earlier move with the text they were applied to. Each list block is its own
 * request, because one request makes one Docs list (one numbering, one glyph).
 */
export function buildWriteRequests(options: BuildWriteRequestsOptions): docs_v1.Schema$Request[] {
  const { tabId, bodyEndIndex, text, spans } = options;
  const requests: docs_v1.Schema$Request[] = [];

  if (bodyEndIndex - 1 > 1) {
    requests.push({
      deleteContentRange: { range: { tabId, startIndex: 1, endIndex: bodyEndIndex - 1 } },
    });
  }
  if (text.length > 0) {
    requests.push({ insertText: { location: { tabId, index: 1 }, text } });
  }
  // A zero-length span would become a degenerate startIndex === endIndex
  // request, which the real Docs API rejects with a 400 that fails the entire
  // atomic batchUpdate. renderer.ts does not produce these; this is a backstop.
  const nonEmpty = spans.filter((span) => span.end > span.start);
  for (const span of nonEmpty) {
    if (span.style.kind !== "list") requests.push(styleRequest(tabId, span));
  }
  const lists = nonEmpty
    .filter((span): span is StyleSpan & { style: { kind: "list"; preset: ListPreset } } => span.style.kind === "list")
    .sort((left, right) => right.start - left.start);
  for (const span of lists) {
    requests.push({
      createParagraphBullets: {
        range: { tabId, startIndex: span.start + 1, endIndex: span.end + 1 },
        bulletPreset: BULLET_PRESET[span.style.preset],
      },
    });
  }

  for (const request of requests) assertHasTabId(request);
  return requests;
}

function styleRequest(tabId: string, span: StyleSpan): docs_v1.Schema$Request {
  const range = { tabId, startIndex: span.start + 1, endIndex: span.end + 1 };
  switch (span.style.kind) {
    case "heading":
      return {
        updateParagraphStyle: {
          range,
          paragraphStyle: { namedStyleType: NAMED_STYLE_BY_LEVEL[span.style.level] },
          fields: "namedStyleType",
        },
      };
    case "bold":
      return { updateTextStyle: { range, textStyle: { bold: true }, fields: "bold" } };
    case "italic":
      return { updateTextStyle: { range, textStyle: { italic: true }, fields: "italic" } };
    case "strikethrough":
      return { updateTextStyle: { range, textStyle: { strikethrough: true }, fields: "strikethrough" } };
    case "link":
      return { updateTextStyle: { range, textStyle: { link: { url: span.style.url } }, fields: "link" } };
    case "list":
      throw new Error("List spans are built by buildWriteRequests, not styleRequest");
  }
}

function assertHasTabId(request: docs_v1.Schema$Request): void {
  const range = request.deleteContentRange?.range
    ?? request.updateParagraphStyle?.range
    ?? request.createParagraphBullets?.range
    ?? request.updateTextStyle?.range;
  const location = request.insertText?.location;
  const tabId = range?.tabId ?? location?.tabId;
  if (tabId === undefined || tabId === null || tabId.length === 0) {
    throw new Error(`Docs request built without a tabId: ${JSON.stringify(request)}`);
  }
}
