import type { docs_v1 } from "googleapis";
import type { StyleSpan } from "./renderer.js";

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

/**
 * Delete-then-insert-then-style, in that literal order: style requests target
 * offsets within the text insertText is about to create, so they cannot run
 * before it. Google's "write backwards" guidance governs ordering among
 * index-shifting requests (delete/insert); the three style request types below
 * never shift indices, so their order relative to each other is irrelevant.
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
  for (const span of spans) {
    requests.push(styleRequest(tabId, span));
  }

  for (const request of requests) assertHasTabId(request);
  return requests;
}

function styleRequest(tabId: string, span: StyleSpan): docs_v1.Schema$Request {
  const range = { tabId, startIndex: span.start + 1, endIndex: span.end + 1 };
  if (span.style.kind === "heading") {
    return {
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: NAMED_STYLE_BY_LEVEL[span.style.level] },
        fields: "namedStyleType",
      },
    };
  }
  if (span.style.kind === "bullet") {
    return {
      createParagraphBullets: { range, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
    };
  }
  if (span.style.kind === "bold") {
    return { updateTextStyle: { range, textStyle: { bold: true }, fields: "bold" } };
  }
  return {
    updateTextStyle: { range, textStyle: { link: { url: span.style.url } }, fields: "link" },
  };
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
