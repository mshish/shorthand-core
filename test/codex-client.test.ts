import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { detectCodexExecutable } from "../src/agent/codex-client.js";

describe("detectCodexExecutable", () => {
  test("returns undefined when nothing is configured, leaving PATH auto-detection to the SDK", () => {
    expect(detectCodexExecutable(undefined, {})).toBeUndefined();
  });

  test("resolves an explicit override", () => {
    expect(detectCodexExecutable("C:\\tools\\codex.exe", {})).toBe(resolve("C:\\tools\\codex.exe"));
  });

  test("falls back to SHORTHAND_CODEX_EXE when no override is passed", () => {
    expect(detectCodexExecutable(undefined, { SHORTHAND_CODEX_EXE: "/opt/codex/bin/codex" }))
      .toBe(resolve("/opt/codex/bin/codex"));
  });

  test("an explicit override wins over the environment variable", () => {
    expect(detectCodexExecutable("/explicit/codex", { SHORTHAND_CODEX_EXE: "/env/codex" }))
      .toBe(resolve("/explicit/codex"));
  });

  test("does not fall back to a hardcoded install path the way detectClaudeExecutable does", () => {
    // No claude.exe-style guess: Codex's own installer layout is unverified here, so
    // guessing one would be exactly the "assume rather than empirically test" this project
    // rules out.
    expect(detectCodexExecutable(undefined, { USERPROFILE: "C:\\Users\\someone" })).toBeUndefined();
  });
});
