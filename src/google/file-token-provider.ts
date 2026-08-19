import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { shorthandConfigDirectory } from "../config.js";
import { tokenError, type TokenProvider, type TokenResult } from "../auth/token-provider.js";

/**
 * The credentials file as core READS it: Google's Application Default Credentials
 * `authorized_user` shape, plus the two fields that name our target.
 *
 * Core does not write this file, and there is no function here that does. One writer
 * per file — a file with two writers in two languages has an invariant that lives in
 * neither of them, and the merge such a scheme needs is exactly the class of silent
 * data loss removing the second writer removes. `src/testing/google-credentials-conformance.ts`
 * is the executable form of the contract a writer must satisfy.
 *
 * The four ADC field names are Google's, not ours: `UserRefreshClient.fromJSON` reads
 * them by those names and throws by name when one is absent. `document_id`/`folder_id`
 * are ours and are in the same file rather than a sibling, because two files with one
 * owner and one write moment means a torn state between them.
 *
 * Only the four ADC fields are required. `document_id` is optional because nothing in
 * core reads it from here — GoogleDocsNoteSink takes documentId as a constructor option —
 * so requiring it would make the file unreadable when absent for no consumer's benefit,
 * and would force whoever performs consent to obtain a target in the same step.
 */
export type GoogleCredentials = Readonly<{
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  document_id?: string;
  folder_id?: string;
}>;

export type CredentialsReadResult =
  | Readonly<{ ok: true; value: GoogleCredentials }>
  | Readonly<{ ok: false; message: string }>;

export function credentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(shorthandConfigDirectory(environment), "google-credentials.json");
}

const REQUIRED_ADC_FIELDS = ["client_id", "client_secret", "refresh_token"] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Reads and validates the credentials file. NEVER throws.
 *
 * The writer is a different program in a different language, so a malformed or partial
 * file is ordinary input rather than a bug in core. It has to arrive at the caller as a
 * reportable "not authorized" — an exception here surfaces mid-capture as a crash
 * instead of as a message telling the user what to do.
 */
export async function readCredentials(path = credentialsPath()): Promise<CredentialsReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, message: `No Google credentials at ${path}; connect your Google account, then retry.` };
    }
    return { ok: false, message: `Google credentials at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: `Google credentials at ${path} are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: `Google credentials at ${path} are not a JSON object.` };
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "authorized_user") {
    return { ok: false, message: `Google credentials at ${path} have type ${JSON.stringify(record.type)}; expected "authorized_user".` };
  }
  for (const field of REQUIRED_ADC_FIELDS) {
    if (!nonEmptyString(record[field])) {
      return { ok: false, message: `Google credentials at ${path} are missing the required field "${field}"; connect your Google account, then retry.` };
    }
  }
  // document_id is NOT validated. A missing target does not make a token unobtainable,
  // and nothing in core reads document_id from this file, so rejecting the file here
  // would only make a perfectly usable credential unreadable. It is carried through when
  // present and omitted when not, exactly like folder_id.
  const documentId = record.document_id;
  const folderId = record.folder_id;
  return {
    ok: true,
    // Unknown top-level keys are dropped rather than rejected: a newer writer adding a
    // field it needs must not break an older core that has never heard of it.
    value: {
      type: "authorized_user",
      client_id: record.client_id as string,
      client_secret: record.client_secret as string,
      refresh_token: record.refresh_token as string,
      ...(nonEmptyString(documentId) ? { document_id: documentId } : {}),
      ...(nonEmptyString(folderId) ? { folder_id: folderId } : {}),
    },
  };
}

export type FileTokenProviderOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  credentialsPath?: string;
  /** Test seam only; production always exchanges the refresh token via OAuth2Client. */
  refreshAccessToken?: (refreshToken: string) => Promise<TokenResult>;
}>;

export class FileTokenProvider implements TokenProvider {
  readonly #path: string;
  readonly #refresh: (refreshToken: string) => Promise<TokenResult>;

  constructor(options: FileTokenProviderOptions) {
    this.#path = options.credentialsPath ?? credentialsPath();
    this.#refresh = options.refreshAccessToken ?? defaultRefresher(options.clientId, options.clientSecret);
  }

  async getAccessToken(): Promise<TokenResult> {
    const credentials = await readCredentials(this.#path);
    if (!credentials.ok) return { ok: false, error: tokenError("not-authorized", credentials.message) };
    // The mapping below applies to both the default OAuth2Client-backed refresher and any
    // injected test-seam refresher, so it lives here rather than inside defaultRefresher —
    // a seam that throws should map the same way a real refresh failure would.
    try {
      return await this.#refresh(credentials.value.refresh_token);
    } catch (error) {
      // Real invalid_grant failures from Google's token endpoint surface via GaxiosError's
      // .message (gaxios builds { message: res.data.error } for a string error body, and
      // .code only ever comes from that cause object's own .code — see gaxios's
      // GaxiosError.extractAPIErrorFromResponse). We also check .code so an injected
      // test-seam error carrying { code: "invalid_grant" } classifies the same way.
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "invalid_grant" || message === "invalid_grant") {
        return { ok: false, error: tokenError("revoked", "Google revoked this credential; reconnect your Google account, then retry.") };
      }
      return { ok: false, error: tokenError("transport", message) };
    }
  }
}

type RefreshableClient = Pick<OAuth2Client, "setCredentials" | "getAccessToken">;

/**
 * Constructs the OAuth2Client once and reuses it across calls, rather than once per call.
 *
 * Verified against the installed google-auth-library source
 * (node_modules/google-auth-library/build/src/auth/oauth2client.js): getAccessTokenAsync()
 * only refreshes when `!this.credentials.access_token || this.isTokenExpiring()`, and
 * isTokenExpiring() returns false when credentials.expiry_date is unset. So a client that
 * lives across calls and already holds a cached access_token (no expiry_date) short-circuits
 * the network round-trip on every call after the first; a client rebuilt per call never has
 * anything cached to check, so it always refreshes over the network.
 */
export function defaultRefresher(
  clientId: string,
  clientSecret: string,
  createClient: () => RefreshableClient = () => new OAuth2Client({ clientId, clientSecret }),
): (refreshToken: string) => Promise<TokenResult> {
  let client: RefreshableClient | undefined;
  return async (refreshToken: string): Promise<TokenResult> => {
    if (client === undefined) {
      client = createClient();
      client.setCredentials({ refresh_token: refreshToken });
    }
    const { token } = await client.getAccessToken();
    if (token === null || token === undefined) {
      return { ok: false, error: tokenError("transport", "Token refresh returned no access token") };
    }
    return { ok: true, token };
  };
}
