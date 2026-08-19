/**
 * The Google Docs sink and its supporting reference implementations, behind
 * the same "own subpath, never imported by anything else in core" pattern
 * markdown.ts established for MarkdownNoteSink.
 */

export { GoogleDocsNoteSink, GOOGLE_DOCS_SCOPE } from "./google/docs-sink.js";
export type { GoogleDocsNoteSinkOptions } from "./google/docs-sink.js";

export { GoogleApiDocsClient } from "./google/docs-client.js";
export type {
  DocsApiError,
  DocsApiResult,
  GoogleDocsApi,
  GetDocumentValue,
  BatchUpdateValue,
  DocsTab,
  DocsParagraph,
} from "./google/docs-client.js";

export { FileTokenProvider, credentialsPath, readCredentials, writeCredentials } from "./google/file-token-provider.js";
export type { FileTokenProviderOptions, GoogleCredentials } from "./google/file-token-provider.js";
