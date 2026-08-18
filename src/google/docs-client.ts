import { docs_v1, google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import type { TokenProvider } from "../auth/token-provider.js";

export type DocsApiError = Readonly<{ httpStatus: number; retryAfterMs?: number; message: string; cause?: unknown }>;
export type DocsApiResult<T> = { ok: true; value: T } | { ok: false; error: DocsApiError };

export type DocsParagraph = Readonly<{ text: string; headingLevel?: 1 | 2 | 3; bullet: boolean }>;
export type DocsTab = Readonly<{
  tabId: string;
  bodyEndIndex: number;
  paragraphs: readonly DocsParagraph[];
  childTabs: readonly DocsTab[];
}>;
export type GetDocumentValue = Readonly<{ revisionId: string; tabs: readonly DocsTab[] }>;
export type BatchUpdateValue = Readonly<{ revisionId: string }>;

export interface GoogleDocsApi {
  getDocument(documentId: string): Promise<DocsApiResult<GetDocumentValue>>;
  batchUpdate(
    documentId: string,
    requests: readonly docs_v1.Schema$Request[],
    targetRevisionId?: string,
  ): Promise<DocsApiResult<BatchUpdateValue>>;
}

type DocsResource = Pick<docs_v1.Docs, "documents">;

export class GoogleApiDocsClient implements GoogleDocsApi {
  readonly #documents: DocsResource["documents"];

  constructor(tokenProvider: TokenProvider, docsResource?: DocsResource) {
    if (docsResource !== undefined) {
      this.#documents = docsResource.documents;
      return;
    }
    const auth = new OAuth2Client();
    auth.setCredentials({});
    // getRequestHeaders is overridden so every call asks the TokenProvider fresh,
    // rather than caching a token this client has no way to invalidate on `revoked`.
    // NOTE: OAuth2Client.requestAsync() (the method googleapis actually calls for
    // every non-http2 request) reads credentials via getRequestMetadataAsync(), not
    // getRequestHeaders() — getRequestHeaders is only consulted on the http2 path,
    // which this client never takes. Overriding getRequestHeaders alone left the
    // TokenProvider unreachable in production (requestAsync's own preflight check
    // rejects the empty setCredentials({}) with a generic "No access, refresh
    // token..." Error before the TokenProvider is ever consulted). Both methods are
    // overridden here, to the same logic, so the TokenProvider is actually asked on
    // every real request.
    const requestHeadersFromTokenProvider = async (): Promise<Headers> => {
      const result = await tokenProvider.getAccessToken();
      if (!result.ok) {
        // A synthetic httpStatus so toDocsApiError's catch handler preserves the
        // TokenProvider's own not-authorized/revoked/transport distinction instead
        // of collapsing everything to httpStatus 0 -> transport. not-authorized and
        // revoked both map to 401 (readErrorFor/writeErrorFor turn that into
        // "forbidden", the correct "go re-authenticate" signal); transport stays at
        // 0, which already falls through to "transport".
        const httpStatus = result.error.code === "transport" ? 0 : 401;
        // OAuth2Client.requestAsync's own catch handler unconditionally reads
        // `res.config.data` off whatever `.response` is present (to check
        // whether the request body was a readable stream, for its retry
        // logic) — a `.response` without a `.config` object makes THAT access
        // throw, discarding this error in favor of an unrelated TypeError.
        // An empty `config` avoids that without adding retry-relevant fields.
        throw Object.assign(
          new Error(`TokenProvider: ${result.error.code}: ${result.error.message}`),
          { response: { status: httpStatus, config: {} }, cause: result.error },
        );
      }
      return new Headers({ Authorization: `Bearer ${result.token}` });
    };
    auth.getRequestHeaders = requestHeadersFromTokenProvider;
    // getRequestMetadataAsync is `protected` on OAuth2Client, but it is the method
    // requestAsync actually calls (see the comment above) — this override has to
    // reach it from outside the class, hence the cast.
    (auth as unknown as { getRequestMetadataAsync: () => Promise<{ headers: Headers }> }).getRequestMetadataAsync =
      async () => ({ headers: await requestHeadersFromTokenProvider() });
    this.#documents = google.docs({ version: "v1", auth }).documents;
  }

  async getDocument(documentId: string): Promise<DocsApiResult<GetDocumentValue>> {
    try {
      const response = await this.#documents.get({ documentId, includeTabsContent: true });
      const revisionId = response.data.revisionId;
      // docs/CONTRACT.md §2.3 requires revision to be a non-empty string. Silently
      // defaulting to "" here would hand that empty string straight back as the
      // next expectedRevision instead of surfacing the missing-field response as
      // an error.
      if (revisionId === undefined || revisionId === null || revisionId.length === 0) {
        return {
          ok: false,
          error: { httpStatus: 0, message: "Docs API response carried no revisionId", cause: response.data },
        };
      }
      const tabs = (response.data.tabs ?? []).map(toDocsTab);
      return { ok: true, value: { revisionId, tabs } };
    } catch (error) {
      return { ok: false, error: toDocsApiError(error) };
    }
  }

  async batchUpdate(
    documentId: string,
    requests: readonly docs_v1.Schema$Request[],
    targetRevisionId?: string,
  ): Promise<DocsApiResult<BatchUpdateValue>> {
    try {
      const response = await this.#documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [...requests],
          ...(targetRevisionId === undefined ? {} : { writeControl: { targetRevisionId } }),
        },
      });
      const revisionId = response.data.writeControl?.requiredRevisionId;
      if (revisionId === undefined || revisionId === null || revisionId.length === 0) {
        return {
          ok: false,
          error: { httpStatus: 0, message: "Docs API response carried no revisionId", cause: response.data },
        };
      }
      return { ok: true, value: { revisionId } };
    } catch (error) {
      return { ok: false, error: toDocsApiError(error) };
    }
  }
}

const HEADING_LEVEL_BY_NAMED_STYLE: Record<string, 1 | 2 | 3> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
};

function toDocsTab(tab: docs_v1.Schema$Tab): DocsTab {
  const content = tab.documentTab?.body?.content ?? [];
  const bodyEndIndex = content.reduce((max, element) => Math.max(max, element.endIndex ?? 0), 0);
  const paragraphs = content
    .map((element) => element.paragraph)
    .filter((paragraph): paragraph is docs_v1.Schema$Paragraph => paragraph !== undefined)
    .map(toDocsParagraph)
    .filter((paragraph) => paragraph.text.length > 0);
  return {
    tabId: tab.tabProperties?.tabId ?? "",
    bodyEndIndex,
    paragraphs,
    childTabs: (tab.childTabs ?? []).map(toDocsTab),
  };
}

function toDocsParagraph(paragraph: docs_v1.Schema$Paragraph): DocsParagraph {
  const text = (paragraph.elements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");
  const namedStyle = paragraph.paragraphStyle?.namedStyleType;
  const headingLevel =
    namedStyle !== undefined && namedStyle !== null ? HEADING_LEVEL_BY_NAMED_STYLE[namedStyle] : undefined;
  return {
    text,
    ...(headingLevel === undefined ? {} : { headingLevel }),
    bullet: paragraph.bullet !== undefined,
  };
}

function toDocsApiError(error: unknown): DocsApiError {
  const response = (error as { response?: { status?: number; headers?: unknown } }).response;
  const status = response?.status ?? 0;
  // gaxios's GaxiosResponse extends the real fetch Response type, so `.headers`
  // is a Headers instance in production — `headers["retry-after"]` on a Headers
  // instance is always undefined; it must be read via `.get()`. A plain object
  // (as used by this repo's own fakes) is also accepted so both shapes work.
  const headers = response?.headers as { get?: (name: string) => string | null } | Record<string, string> | undefined;
  const retryAfterHeader = typeof headers?.get === "function"
    ? headers.get("retry-after")
    : (headers as Record<string, string> | undefined)?.["retry-after"];
  const retryAfterSeconds = retryAfterHeader === null || retryAfterHeader === undefined
    ? undefined
    : Number(retryAfterHeader);
  // An HTTP-date-format Retry-After value (or any other non-numeric value)
  // must not silently become NaN; docs/CONTRACT.md §4 requires the value be
  // positive when present at all.
  const retryAfterMs = retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
    ? retryAfterSeconds * 1000
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return { httpStatus: status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), message, cause: error };
}
