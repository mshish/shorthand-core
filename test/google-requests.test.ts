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

  test("a bullet span becomes createParagraphBullets over the shifted range", () => {
    const spans: readonly StyleSpan[] = [{ start: 0, end: 4, style: { kind: "bullet" } }];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "Ship", spans });
    const bullet = requests.find((request) => "createParagraphBullets" in request)!.createParagraphBullets;
    expect(bullet).toMatchObject({ range: { tabId: "t1", startIndex: 1, endIndex: 5 } });
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
      { start: 3, end: 3, style: { kind: "bullet" } },
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
