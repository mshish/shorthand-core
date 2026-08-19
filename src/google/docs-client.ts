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
  addDocumentTab(documentId: string, title: string): Promise<DocsApiResult<{ tabId: string }>>;
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
    // refreshHandler is google-auth-library's own public, documented seam for
    // exactly this "bring your own token supplier" case (see its README's
    // refreshHandler example). OAuth2Client.requestAsync() -> getRequestMetadataAsync()
    // calls refreshHandler() whenever there's no cached, non-expiring access_token,
    // then setCredentials()s the result — so returning an already-expired
    // expiry_date below makes isTokenExpiring() true on every subsequent call,
    // which means every request re-invokes refreshHandler and asks the
    // TokenProvider fresh, rather than caching a token this client has no way to
    // invalidate on `revoked` (that invalidation is the TokenProvider's job).
    // An earlier version of this reached the same behavior by overriding
    // getRequestMetadataAsync directly, which required a cast because that method
    // is `protected` — internal to OAuth2Client, not part of its public contract,
    // so depending on its exact name/behavior could silently break on a future
    // patch/minor bump. refreshHandler is the field the library documents for this
    // purpose, so it needs no cast and is safe to rely on across versions.
    auth.refreshHandler = async () => {
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
      // expiry_date 0 is always in the past, so isTokenExpiring() is always true
      // and OAuth2Client never serves a cached access_token — see the comment
      // above auth.refreshHandler.
      return { access_token: result.token, expiry_date: 0 };
    };
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

  async addDocumentTab(documentId: string, title: string): Promise<DocsApiResult<{ tabId: string }>> {
    try {
      const response = await this.#documents.batchUpdate({
        documentId,
        requestBody: { requests: [{ addDocumentTab: { tabProperties: { title } } }] },
      });
      const tabId = response.data.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
      if (tabId === undefined || tabId === null || tabId.length === 0) {
        return {
          ok: false,
          error: { httpStatus: 0, message: "Docs API response carried no tabId for the new tab", cause: response.data },
        };
      }
      return { ok: true, value: { tabId } };
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
