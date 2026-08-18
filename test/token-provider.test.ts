import { describe, expect, test } from "bun:test";
import { tokenError, type TokenProvider, type TokenResult } from "../src/auth/token-provider.js";

describe("tokenError", () => {
  test("omits cause entirely when not supplied", () => {
    const error = tokenError("not-authorized", "no credential yet");
    expect(error).toEqual({ code: "not-authorized", message: "no credential yet" });
    expect("cause" in error).toBe(false);
  });

  test("includes cause when supplied", () => {
    const cause = new Error("network down");
    const error = tokenError("transport", "refresh failed", cause);
    expect(error).toEqual({ code: "transport", message: "refresh failed", cause });
  });
});

describe("TokenProvider", () => {
  test("a conforming implementation satisfies the interface", async () => {
    const provider: TokenProvider = {
      getAccessToken: async (): Promise<TokenResult> => ({ ok: true, token: "abc" }),
    };
    expect(await provider.getAccessToken()).toEqual({ ok: true, token: "abc" });
  });
});
