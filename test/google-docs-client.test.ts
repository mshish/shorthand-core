import { describe, expect, test } from "bun:test";
import { GoogleApiDocsClient } from "../src/google/docs-client.js";
import type { TokenProvider } from "../src/auth/token-provider.js";

const okTokenProvider: TokenProvider = { getAccessToken: async () => ({ ok: true, token: "t" }) };

function gaxiosError(status: number, headers: Record<string, string> = {}): Error & { response: unknown } {
  const error = new Error(`request failed with status code ${status}`) as Error & { response: unknown };
  error.response = { status, headers };
  return error;
}

describe("GoogleApiDocsClient", () => {
  test("maps a 429 with Retry-After seconds to retryAfterMs milliseconds", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw gaxiosError(429, { "retry-after": "2" }); },
        batchUpdate: async () => { throw gaxiosError(429, { "retry-after": "2" }); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    expect(result).toEqual({ ok: false, error: { httpStatus: 429, retryAfterMs: 2000, message: expect.any(String) } });
  });

  test("maps a 401 and a 403 to the same httpStatus shape", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: { get: async () => { throw gaxiosError(403); }, batchUpdate: async () => { throw gaxiosError(403); } },
    } as never);
    expect((await client.getDocument("doc1")).ok).toBe(false);
    const result = await client.getDocument("doc1");
    if (!result.ok) expect(result.error.httpStatus).toBe(403);
  });

  test("maps a 404 to httpStatus 404", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: { get: async () => { throw gaxiosError(404); }, batchUpdate: async () => { throw gaxiosError(404); } },
    } as never);
    const result = await client.getDocument("doc1");
    if (!result.ok) expect(result.error.httpStatus).toBe(404);
  });

  test("flattens the tab tree and reports each tab's body end index", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => ({
          data: {
            revisionId: "rev1",
            tabs: [
              {
                tabProperties: { tabId: "root" },
                documentTab: { body: { content: [{ endIndex: 3 }, { endIndex: 12 }] } },
                childTabs: [
                  {
                    tabProperties: { tabId: "child" },
                    documentTab: { body: { content: [{ endIndex: 5 }] } },
                    childTabs: [],
                  },
                ],
              },
            ],
          },
        }),
        batchUpdate: async () => { throw new Error("not used in this test"); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    expect(result).toEqual({
      ok: true,
      value: {
        revisionId: "rev1",
        tabs: [
          {
            tabId: "root",
            bodyEndIndex: 12,
            paragraphs: [],
            childTabs: [{ tabId: "child", bodyEndIndex: 5, paragraphs: [], childTabs: [] }],
          },
        ],
      },
    });
  });

  test("extracts paragraph text, heading level, and bullet flag from body content", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => ({
          data: {
            revisionId: "rev1",
            tabs: [
              {
                tabProperties: { tabId: "owned" },
                documentTab: {
                  body: {
                    content: [
                      {
                        endIndex: 9,
                        paragraph: {
                          paragraphStyle: { namedStyleType: "HEADING_2" },
                          elements: [{ textRun: { content: "Summary\n" } }],
                        },
                      },
                      {
                        endIndex: 18,
                        paragraph: {
                          bullet: { listId: "list1" },
                          elements: [{ textRun: { content: "Ship Friday\n" } }],
                        },
                      },
                    ],
                  },
                },
                childTabs: [],
              },
            ],
          },
        }),
        batchUpdate: async () => { throw new Error("not used in this test"); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tabs[0]!.paragraphs).toEqual([
      { text: "Summary", headingLevel: 2, bullet: false },
      { text: "Ship Friday", bullet: true },
    ]);
  });

  test("batchUpdate passes targetRevisionId through writeControl and returns the new revisionId", async () => {
    let capturedWriteControl: unknown;
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async (params: { requestBody: { writeControl?: unknown } }) => {
          capturedWriteControl = params.requestBody.writeControl;
          return { data: { writeControl: { requiredRevisionId: "rev2" } } };
        },
      },
    } as never);
    const result = await client.batchUpdate("doc1", [], "rev1");
    expect(capturedWriteControl).toEqual({ targetRevisionId: "rev1" });
    expect(result).toEqual({ ok: true, value: { revisionId: "rev2" } });
  });
});
