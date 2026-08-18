import { docs_v1, google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import type { TokenProvider } from "../auth/token-provider.js";

export type DocsApiError = Readonly<{ httpStatus: number; retryAfterMs?: number; message: string }>;
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
    auth.getRequestHeaders = async () => {
      const result = await tokenProvider.getAccessToken();
      if (!result.ok) throw new Error(`TokenProvider: ${result.error.code}: ${result.error.message}`);
      return new Headers({ Authorization: `Bearer ${result.token}` });
    };
    this.#documents = google.docs({ version: "v1", auth }).documents;
  }

  async getDocument(documentId: string): Promise<DocsApiResult<GetDocumentValue>> {
    try {
      const response = await this.#documents.get({ documentId, includeTabsContent: true });
      const tabs = (response.data.tabs ?? []).map(toDocsTab);
      return { ok: true, value: { revisionId: response.data.revisionId ?? "", tabs } };
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
      const revisionId = response.data.writeControl?.requiredRevisionId ?? "";
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
  const response = (error as { response?: { status?: number; headers?: Record<string, string> } }).response;
  const status = response?.status ?? 0;
  const retryAfterHeader = response?.headers?.["retry-after"];
  const retryAfterMs = retryAfterHeader !== undefined ? Number(retryAfterHeader) * 1000 : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return { httpStatus: status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), message };
}
