import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UserRefreshClient } from "google-auth-library";
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
  credentialsPath?: string;
  /** Test seam only; production always refreshes via google-auth-library's UserRefreshClient. */
  refreshAccessToken?: (credentials: GoogleCredentials) => Promise<TokenResult>;
}>;

export class FileTokenProvider implements TokenProvider {
  readonly #path: string;
  readonly #refresh: (credentials: GoogleCredentials) => Promise<TokenResult>;

  constructor(options: FileTokenProviderOptions = {}) {
    this.#path = options.credentialsPath ?? credentialsPath();
    this.#refresh = options.refreshAccessToken ?? defaultRefresher();
  }

  async getAccessToken(): Promise<TokenResult> {
    const credentials = await readCredentials(this.#path);
    if (!credentials.ok) return { ok: false, error: tokenError("not-authorized", credentials.message) };
    // The mapping below applies to both the default OAuth2Client-backed refresher and any
    // injected test-seam refresher, so it lives here rather than inside defaultRefresher —
    // a seam that throws should map the same way a real refresh failure would.
    try {
      return await this.#refresh(credentials.value);
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

type RefreshableClient = Pick<UserRefreshClient, "getAccessToken">;

/**
 * Hands the credential to google-auth-library's own ADC loader and holds ONE client
 * across calls.
 *
 * Verified against the installed source
 * (node_modules/google-auth-library/build/src/auth/refreshclient.js): the static
 * fromJSON builds a UserRefreshClient and sets credentials.refresh_token itself, so no
 * separate setCredentials call is needed; and UserRefreshClient extends OAuth2Client
 * overriding only refreshTokenNoCache and fetchIdToken, so getAccessToken() is inherited
 * unmodified and still refreshes only when `!credentials.access_token ||
 * isTokenExpiring()`. A client rebuilt per call therefore has nothing cached to check
 * and pays a full token-endpoint round-trip every time — the exact regression this
 * closure shape was introduced to fix.
 */
export function defaultRefresher(
  createClient: (credentials: GoogleCredentials) => RefreshableClient =
    (credentials) => UserRefreshClient.fromJSON(credentials),
): (credentials: GoogleCredentials) => Promise<TokenResult> {
  let client: RefreshableClient | undefined;
  return async (credentials: GoogleCredentials): Promise<TokenResult> => {
    client ??= createClient(credentials);
    const { token } = await client.getAccessToken();
    if (token === null || token === undefined) {
      return { ok: false, error: tokenError("transport", "Token refresh returned no access token") };
    }
    return { ok: true, token };
  };
}
