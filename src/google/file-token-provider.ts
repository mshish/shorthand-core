import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { shorthandConfigDirectory } from "../config.js";
import { tokenError, type TokenProvider, type TokenResult } from "../auth/token-provider.js";

export type GoogleCredentials = Readonly<{ refreshToken: string; documentId: string; tabId?: string }>;

export function credentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(shorthandConfigDirectory(environment), "google-credentials.json");
}

export async function writeCredentials(credentials: GoogleCredentials, path = credentialsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2), "utf8");
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function readCredentials(path = credentialsPath()): Promise<GoogleCredentials | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as GoogleCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Merges a fresh refreshToken/documentId (from a `google-login` run) with any
 * credentials already on disk, preserving an existing `tabId`. writeCredentials
 * overwrites the whole file, so a re-login that only ever passed the two fields
 * it obtained would otherwise silently drop a `tabId` some other path had
 * stored there.
 */
export function mergeCredentials(
  existing: GoogleCredentials | undefined,
  update: Readonly<{ refreshToken: string; documentId: string }>,
): GoogleCredentials {
  return {
    refreshToken: update.refreshToken,
    documentId: update.documentId,
    ...(existing?.tabId === undefined ? {} : { tabId: existing.tabId }),
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
    if (credentials === undefined) {
      return { ok: false, error: tokenError("not-authorized", `No Google credentials at ${this.#path}; run \`shorthand-notes google-login\` first.`) };
    }
    // The mapping below applies to both the default OAuth2Client-backed refresher and any
    // injected test-seam refresher, so it lives here rather than inside defaultRefresher —
    // a seam that throws should map the same way a real refresh failure would.
    try {
      return await this.#refresh(credentials.refreshToken);
    } catch (error) {
      // Real invalid_grant failures from Google's token endpoint surface via GaxiosError's
      // .message (gaxios builds { message: res.data.error } for a string error body, and
      // .code only ever comes from that cause object's own .code — see gaxios's
      // GaxiosError.extractAPIErrorFromResponse). We also check .code so an injected
      // test-seam error carrying { code: "invalid_grant" } classifies the same way.
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "invalid_grant" || message === "invalid_grant") {
        return { ok: false, error: tokenError("revoked", "Google revoked this credential; run google-login again") };
      }
      return { ok: false, error: tokenError("transport", message) };
    }
  }
}

function defaultRefresher(clientId: string, clientSecret: string): (refreshToken: string) => Promise<TokenResult> {
  return async (refreshToken: string): Promise<TokenResult> => {
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials({ refresh_token: refreshToken });
    const { token } = await client.getAccessToken();
    if (token === null || token === undefined) {
      return { ok: false, error: tokenError("transport", "Token refresh returned no access token") };
    }
    return { ok: true, token };
  };
}
