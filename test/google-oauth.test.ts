import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { buildAuthorizationUrl, generatePkceChallenge, listenForRedirect } from "../src/google/oauth.js";

describe("generatePkceChallenge", () => {
  test("produces a verifier and a derived S256 challenge", async () => {
    const challenge = await generatePkceChallenge(new OAuth2Client());
    expect(challenge.codeVerifier.length).toBeGreaterThan(40);
    expect(challenge.codeChallenge.length).toBeGreaterThan(0);
    expect(challenge.codeChallenge).not.toBe(challenge.codeVerifier);
  });
});

describe("buildAuthorizationUrl", () => {
  test("includes PKCE, offline access, consent prompt, and the one-pick trigger", () => {
    const url = new URL(buildAuthorizationUrl({
      clientId: "client-1", redirectUri: "http://127.0.0.1:9999/callback",
      codeChallenge: "challenge-abc", scope: "https://www.googleapis.com/auth/drive.file",
    }));
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9999/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("trigger_onepick")).toBe("true");
  });

  test("never includes a second scope alongside drive.file", () => {
    const url = new URL(buildAuthorizationUrl({
      clientId: "c", redirectUri: "http://127.0.0.1:9999/callback",
      codeChallenge: "x", scope: "https://www.googleapis.com/auth/drive.file",
    }));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
  });
});

describe("listenForRedirect", () => {
  test("captures the auth code and picked_file_ids from the redirect query string", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP port");
    server.close();

    const pending = listenForRedirect(address.port);
    await fetch(`http://127.0.0.1:${address.port}/?code=auth-code-1&picked_file_ids=doc-abc`);
    const result = await pending;
    expect(result).toEqual({ code: "auth-code-1", pickedFileIds: ["doc-abc"] });
  });
});
