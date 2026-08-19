import { describe, expect, test } from "bun:test";
import { GoogleApiDocsClient } from "../src/google/docs-client.js";
import type { TokenProvider } from "../src/auth/token-provider.js";

const okTokenProvider: TokenProvider = { getAccessToken: async () => ({ ok: true, token: "t" }) };

function gaxiosError(status: number, headers: Record<string, string> = {}): Error & { response: unknown } {
  const error = new Error(`request failed with status code ${status}`) as Error & { response: unknown };
  error.response = { status, headers };
  return error;
}

function gaxiosErrorWithRealHeaders(status: number, headers: Record<string, string> = {}): Error & { response: unknown } {
  const error = new Error(`request failed with status code ${status}`) as Error & { response: unknown };
  error.response = { status, headers: new Headers(headers) };
  return error;
}

describe("GoogleApiDocsClient", () => {
  test("maps a 429 with Retry-After seconds to retryAfterMs milliseconds", async () => {
    // Regression: gaxios's GaxiosResponse extends the real fetch Response type,
    // so `.headers` is a real Headers instance in production, not a plain
    // object — `headers["retry-after"]` on a Headers instance is always
    // undefined. This uses a real `Headers` instance (not a plain object) so
    // the test actually exercises that shape.
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw gaxiosErrorWithRealHeaders(429, { "retry-after": "2" }); },
        batchUpdate: async () => { throw gaxiosErrorWithRealHeaders(429, { "retry-after": "2" }); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    expect(result).toEqual({ ok: false, error: { httpStatus: 429, retryAfterMs: 2000, message: expect.any(String), cause: expect.anything() } });
  });

  test("a non-numeric (HTTP-date-format) Retry-After does not produce NaN", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw gaxiosErrorWithRealHeaders(429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }); },
        batchUpdate: async () => { throw new Error("not used in this test"); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    if (result.ok) throw new Error("expected an error result");
    expect(result.error.retryAfterMs).toBeUndefined();
    expect(Number.isNaN(result.error.retryAfterMs)).toBe(false);
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

  test("getDocument rejects a response with no revisionId rather than defaulting to an empty string", async () => {
    // docs/CONTRACT.md §2.3 requires revision to be a non-empty string. Silently
    // defaulting a missing field to "" would hand that "" straight back as the
    // next expectedRevision.
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => ({ data: { tabs: [] } }),
        batchUpdate: async () => { throw new Error("not used in this test"); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.httpStatus).toBe(0);
      expect(result.error.message).toContain("revisionId");
    }
  });

  test("batchUpdate rejects a response with no revisionId rather than defaulting to an empty string", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async () => ({ data: {} }),
      },
    } as never);
    const result = await client.batchUpdate("doc1", [], "rev1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.httpStatus).toBe(0);
      expect(result.error.message).toContain("revisionId");
    }
  });

  test("cause is populated on the DocsApiError from the caught error", async () => {
    const originalError = gaxiosErrorWithRealHeaders(500);
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw originalError; },
        batchUpdate: async () => { throw new Error("not used in this test"); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cause).toBe(originalError);
  });

  test("addDocumentTab returns the new tab's id from the batchUpdate reply", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async (request: unknown) => {
          const body = (request as { requestBody: { requests: Array<{ addDocumentTab?: { tabProperties?: { title?: string } } }> } }).requestBody;
          expect(body.requests).toEqual([{ addDocumentTab: { tabProperties: { title: "Meeting" } } }]);
          return { data: { replies: [{ addDocumentTab: { tabProperties: { tabId: "new-tab-1" } } }] } };
        },
      },
    } as never);
    const result = await client.addDocumentTab("doc1", "Meeting");
    expect(result).toEqual({ ok: true, value: { tabId: "new-tab-1" } });
  });

  test("addDocumentTab maps a batchUpdate failure the same way batchUpdate itself does", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async () => { throw gaxiosError(403); },
      },
    } as never);
    const result = await client.addDocumentTab("doc1", "Meeting");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.httpStatus).toBe(403);
  });

  test("addDocumentTab reports an error when the response carries no tabId", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async () => ({ data: { replies: [{ addDocumentTab: {} }] } }),
      },
    } as never);
    const result = await client.addDocumentTab("doc1", "Meeting");
    expect(result).toEqual({
      ok: false,
      error: { httpStatus: 0, message: "Docs API response carried no tabId for the new tab", cause: expect.anything() },
    });
  });

  describe("TokenProvider error mapping through getRequestHeaders", () => {
    // These tests deliberately do NOT inject a docsResource, so the real
    // OAuth2Client/getRequestHeaders override runs. A TokenProvider failure
    // throws before any network request is made, so this needs no live network.
    test("a not-authorized TokenProvider error maps to httpStatus 401 (forbidden upstream)", async () => {
      const client = new GoogleApiDocsClient({
        getAccessToken: async () => ({ ok: false, error: { code: "not-authorized", message: "no credentials" } }),
      });
      const result = await client.getDocument("doc1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.httpStatus).toBe(401);
    });

    test("a revoked TokenProvider error maps to httpStatus 401 (forbidden upstream), not a generic transport error", async () => {
      const client = new GoogleApiDocsClient({
        getAccessToken: async () => ({ ok: false, error: { code: "revoked", message: "credential revoked" } }),
      });
      const result = await client.getDocument("doc1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.httpStatus).toBe(401);
    });

    test("a transport TokenProvider error maps to httpStatus 0 (transport)", async () => {
      const client = new GoogleApiDocsClient({
        getAccessToken: async () => ({ ok: false, error: { code: "transport", message: "network down" } }),
      });
      const result = await client.getDocument("doc1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.httpStatus).toBe(0);
    });
  });
});
