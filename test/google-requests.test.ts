import { describe, expect, test } from "bun:test";
import { buildWriteRequests } from "../src/google/requests.js";
import type { StyleSpan } from "../src/google/renderer.js";

/** The three requests that clear inherited styles from what was just inserted. */
const RESET_KEYS = ["deleteParagraphBullets", "updateParagraphStyle", "updateTextStyle"];

/** Drops the style reset that follows every insertText, so a test can look at the span requests alone. */
function styled(text: string, spans: readonly StyleSpan[], bodyEndIndex = 1) {
  const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex, text, spans });
  const insert = requests.findIndex((request) => "insertText" in request);
  return insert === -1 ? requests : [...requests.slice(0, insert + 1), ...requests.slice(insert + 1 + RESET_KEYS.length)];
}

describe("buildWriteRequests", () => {
  test("emits delete, then insert, then style requests, in that order", () => {
    const spans: readonly StyleSpan[] = [
      { start: 0, end: 7, style: { kind: "heading", level: 2 } },
    ];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 50, text: "Summary\n", spans });
    expect(requests.map((request) => Object.keys(request)[0])).toEqual([
      "deleteContentRange",
      "insertText",
      ...RESET_KEYS,
      "updateParagraphStyle",
    ]);
  });

  test("resets the inserted text to plain paragraphs before styling it", () => {
    // Inserted paragraphs take the style of the tab's last paragraph, which survives the
    // delete: a last list item or heading would otherwise spread to all of the notes.
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 50, text: "Summary\n", spans: [] });
    const range = { tabId: "t1", startIndex: 1, endIndex: 9 };
    expect(requests.slice(2)).toEqual([
      { deleteParagraphBullets: { range } },
      { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
      { updateTextStyle: { range, textStyle: {}, fields: "bold,italic,strikethrough,link,foregroundColor,fontSize" } },
    ]);
  });

  test("a muted span becomes small grey text", () => {
    const requests = styled("status", [{ start: 0, end: 6, style: { kind: "muted" } }]);
    expect(requests[1]!.updateTextStyle).toEqual({
      range: { tabId: "t1", startIndex: 1, endIndex: 7 },
      textStyle: { foregroundColor: { color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } } }, fontSize: { magnitude: 9, unit: "PT" } },
      fields: "foregroundColor,fontSize",
    });
  });

  test("deleteContentRange uses bodyEndIndex - 1, never bodyEndIndex", () => {
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 50, text: "x", spans: [] });
    expect(requests[0]!.deleteContentRange).toMatchObject({
      range: { tabId: "t1", startIndex: 1, endIndex: 49 },
    });
  });

  test("omits deleteContentRange when the tab body is already empty", () => {
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "x", spans: [] });
    expect(requests.some((request) => "deleteContentRange" in request)).toBe(false);
  });

  test("omits insertText when the rendered text is empty", () => {
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 5, text: "", spans: [] });
    expect(requests.some((request) => "insertText" in request)).toBe(false);
  });

  test("insertText targets index 1 with the full text, tabId included", () => {
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 5, text: "hello", spans: [] });
    expect(requests.find((request) => "insertText" in request)!.insertText).toEqual({
      location: { tabId: "t1", index: 1 },
      text: "hello",
    });
  });

  test("a list span becomes createParagraphBullets over the shifted range with its preset", () => {
    const spans: readonly StyleSpan[] = [{ start: 0, end: 5, style: { kind: "list", preset: "checkbox" } }];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "Ship\n", spans });
    const bullet = requests.find((request) => "createParagraphBullets" in request)!.createParagraphBullets;
    expect(bullet).toEqual({ range: { tabId: "t1", startIndex: 1, endIndex: 6 }, bulletPreset: "BULLET_CHECKBOX" });
  });

  test("list requests come after every style request, last list first", () => {
    // createParagraphBullets removes each paragraph's leading tabs, shifting later indices.
    const spans: readonly StyleSpan[] = [
      { start: 0, end: 3, style: { kind: "list", preset: "bullet" } },
      { start: 4, end: 7, style: { kind: "list", preset: "numbered" } },
      { start: 5, end: 6, style: { kind: "italic" } },
    ];
    const requests = styled("\ta\n\tb\n", spans);
    expect(requests.map((request) => Object.keys(request)[0])).toEqual([
      "insertText",
      "updateTextStyle",
      "createParagraphBullets",
      "createParagraphBullets",
    ]);
    expect(requests[2]!.createParagraphBullets!.bulletPreset).toBe("NUMBERED_DECIMAL_ALPHA_ROMAN");
    expect(requests[3]!.createParagraphBullets!.bulletPreset).toBe("BULLET_DISC_CIRCLE_SQUARE");
  });

  test("italic and strikethrough spans become updateTextStyle with their own field", () => {
    const spans: readonly StyleSpan[] = [
      { start: 0, end: 1, style: { kind: "italic" } },
      { start: 1, end: 2, style: { kind: "strikethrough" } },
    ];
    const requests = styled("ab", spans);
    expect(requests.slice(1).map((request) => request.updateTextStyle!.fields)).toEqual(["italic", "strikethrough"]);
  });

  test("a bold span becomes updateTextStyle with fields=bold over the shifted range", () => {
    const spans: readonly StyleSpan[] = [{ start: 2, end: 6, style: { kind: "bold" } }];
    const requests = styled("ok bold ok", spans);
    const style = requests.find((request) => "updateTextStyle" in request)!.updateTextStyle;
    expect(style).toMatchObject({
      range: { tabId: "t1", startIndex: 3, endIndex: 7 },
      textStyle: { bold: true },
      fields: "bold",
    });
  });

  test("a link span becomes updateTextStyle with fields=link and the URL", () => {
    const spans: readonly StyleSpan[] = [{ start: 0, end: 3, style: { kind: "link", url: "https://x" } }];
    const requests = styled("doc", spans);
    const style = requests.find((request) => "updateTextStyle" in request)!.updateTextStyle;
    expect(style).toMatchObject({
      textStyle: { link: { url: "https://x" } },
      fields: "link",
    });
  });

  test("a zero-length span produces no request for that span", () => {
    // Defensive backstop: a zero-length bullet span (start === end) would become
    // a degenerate createParagraphBullets request the real Docs API rejects with
    // a 400, failing the whole atomic batchUpdate.
    const spans: readonly StyleSpan[] = [
      { start: 3, end: 3, style: { kind: "list", preset: "bullet" } },
      { start: 0, end: 3, style: { kind: "bold" } },
    ];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "abc", spans });
    expect(requests.some((request) => "createParagraphBullets" in request)).toBe(false);
    expect(requests.some((request) => "updateTextStyle" in request)).toBe(true);
  });

  test("throws if any constructed request would lack a tabId", () => {
    expect(() => buildWriteRequests({ tabId: "", bodyEndIndex: 5, text: "x", spans: [] })).toThrow();
  });
});
