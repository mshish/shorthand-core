import { createServer } from "node:http";
import type { OAuth2Client } from "google-auth-library";

export type PkceChallenge = Readonly<{ codeVerifier: string; codeChallenge: string }>;

export async function generatePkceChallenge(client: OAuth2Client): Promise<PkceChallenge> {
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  // The library types codeChallenge as optional (it's shared with a plain-verifier path
  // that never sets it), but generateCodeVerifierAsync() always derives one via SHA256.
  if (codeChallenge === undefined) {
    throw new Error("google-auth-library did not derive a code_challenge from the code_verifier");
  }
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizationUrl(options: Readonly<{
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
}>): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("trigger_onepick", "true");
  return url.toString();
}

export type LoopbackResult = Readonly<{ code: string; pickedFileIds: readonly string[] }>;

export function listenForRedirect(port: number): Promise<LoopbackResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(code === null ? "Missing authorization code." : "You may close this tab and return to Shorthand.");
      server.close();
      if (code === null) {
        rejectPromise(new Error(`OAuth redirect missing code: ${url.search}`));
        return;
      }
      const pickedFileIds = url.searchParams.get("picked_file_ids")?.split(",").filter((id) => id.length > 0) ?? [];
      resolvePromise({ code, pickedFileIds });
    });
    server.on("error", rejectPromise);
    server.listen(port, "127.0.0.1");
  });
}

export type ExchangedTokens = Readonly<{ refreshToken: string }>;

export async function exchangeCode(
  client: OAuth2Client,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<ExchangedTokens> {
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  if (tokens.refresh_token === null || tokens.refresh_token === undefined) {
    throw new Error("Google did not return a refresh token — retry with prompt=consent (already set) on a fresh consent grant.");
  }
  return { refreshToken: tokens.refresh_token };
}
