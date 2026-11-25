import { describe, expect, test } from "bun:test";
import { buildWriteRequests } from "../src/google/requests.js";
import type { StyleSpan } from "../src/google/renderer.js";

describe("buildWriteRequests", () => {
  test("emits delete, then insert, then style requests, in that order", () => {
    const spans: readonly StyleSpan[] = [
      { start: 0, end: 7, style: { kind: "heading", level: 2 } },
    ];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 50, text: "Summary\n", spans });
    expect(Object.keys(requests[0]!)).toEqual(["deleteContentRange"]);
    expect(Object.keys(requests[1]!)).toEqual(["insertText"]);
    expect(Object.keys(requests[2]!)).toEqual(["updateParagraphStyle"]);
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
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "\ta\n\tb\n", spans });
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
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "ab", spans });
    expect(requests.slice(1).map((request) => request.updateTextStyle!.fields)).toEqual(["italic", "strikethrough"]);
  });

  test("a bold span becomes updateTextStyle with fields=bold over the shifted range", () => {
    const spans: readonly StyleSpan[] = [{ start: 2, end: 6, style: { kind: "bold" } }];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "ok bold ok", spans });
    const style = requests.find((request) => "updateTextStyle" in request)!.updateTextStyle;
    expect(style).toMatchObject({
      range: { tabId: "t1", startIndex: 3, endIndex: 7 },
      textStyle: { bold: true },
      fields: "bold",
    });
  });

  test("a link span becomes updateTextStyle with fields=link and the URL", () => {
    const spans: readonly StyleSpan[] = [{ start: 0, end: 3, style: { kind: "link", url: "https://x" } }];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "doc", spans });
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
