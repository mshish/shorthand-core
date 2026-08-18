/**
 * The credential-supply port for API-backed sinks — the TokenProvider equivalent
 * of NoteSink (src/note/sink.ts). Core never performs OAuth or holds a browser
 * consent flow; a TokenProvider implementation is always a consumer concern.
 */

export type TokenErrorCode = "not-authorized" | "revoked" | "transport";

export type TokenError = Readonly<{
  code: TokenErrorCode;
  message: string;
  cause?: unknown;
}>;

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; error: TokenError };

export interface TokenProvider {
  getAccessToken(): Promise<TokenResult>;
}

export function tokenError(code: TokenErrorCode, message: string, cause?: unknown): TokenError {
  return { code, message, ...(cause === undefined ? {} : { cause }) };
}
