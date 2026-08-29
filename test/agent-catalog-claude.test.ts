import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { AccountInfo, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { classifyClaudeCatalogFailure, toClaudeCatalog } from "../src/agent/client.js";
import { AgentCatalogError } from "../src/agent/catalog.js";

const fixturePath = fileURLToPath(new URL("./fixtures/claude-model-catalog.json", import.meta.url));
const fixtureModels = JSON.parse(readFileSync(fixturePath, "utf8")) as ModelInfo[];

const SIGNED_IN_ACCOUNT: AccountInfo = { email: "user@example.com", apiProvider: "firstParty" };
const SIGNED_OUT_ACCOUNT: AccountInfo = { tokenSource: "none", apiProvider: "firstParty" };

describe("toClaudeCatalog", () => {
  test("maps the fixture's ids, display names and efforts", () => {
    const catalog = toClaudeCatalog(fixtureModels, SIGNED_IN_ACCOUNT);
    expect(catalog.models).toEqual([
      {
        id: "default",
        displayName: "Default (recommended)",
        description: "Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "opus[1m]",
        displayName: "Opus (1M context)",
        description: "Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "claude-fable-5[1m]",
        displayName: "Fable",
        description: "Fable 5 · Most capable for your hardest and longest-running tasks",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "sonnet",
        displayName: "Sonnet",
        description: "Sonnet 5 · Efficient for routine tasks · $3/$15 per Mtok",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok",
        efforts: [],
      },
    ]);
  });

  test("haiku has no supportsEffort or supportedEffortLevels and maps to an empty efforts array", () => {
    const catalog = toClaudeCatalog(fixtureModels, SIGNED_IN_ACCOUNT);
    const haiku = catalog.models.find((model) => model.id === "haiku");
    expect(haiku).toBeDefined();
    expect(haiku?.efforts).toEqual([]);
    // Absence, not a zero-length default invented here: neither field is present on the
    // fixture row at all, which is the load-bearing case this mapping must preserve.
    const rawHaiku = fixtureModels.find((model) => model.value === "haiku");
    expect(rawHaiku?.supportsEffort).toBeUndefined();
    expect(rawHaiku?.supportedEffortLevels).toBeUndefined();
  });

  test("preserves the SDK's catalog order rather than sorting it", () => {
    const catalog = toClaudeCatalog(fixtureModels, SIGNED_IN_ACCOUNT);
    expect(catalog.models.map((model) => model.id)).toEqual([
      "default",
      "opus[1m]",
      "claude-fable-5[1m]",
      "sonnet",
      "haiku",
    ]);
  });

  test("signedIn is true and account is the email when the SDK names an account", () => {
    const catalog = toClaudeCatalog(fixtureModels, SIGNED_IN_ACCOUNT);
    expect(catalog.signedIn).toBe(true);
    expect(catalog.account).toBe("user@example.com");
  });

  test("signedIn is false and account is unset when the SDK reports no email", () => {
    const catalog = toClaudeCatalog(fixtureModels, SIGNED_OUT_ACCOUNT);
    expect(catalog.signedIn).toBe(false);
    expect(catalog).not.toHaveProperty("account");
  });

  test("an empty-string email is treated as signed out, not as a blank account", () => {
    // "" is falsy but !== undefined — the degenerate case the naive `email !== undefined`
    // check would have gotten wrong (see client.ts's toClaudeCatalog comment).
    const catalog = toClaudeCatalog(fixtureModels, { email: "", apiProvider: "firstParty" });
    expect(catalog.signedIn).toBe(false);
    expect(catalog).not.toHaveProperty("account");
  });

  test("a model asserting supportsEffort with no supportedEffortLevels is a protocol error", () => {
    const garbage = [
      { value: "sonnet", displayName: "Sonnet", description: "d", supportsEffort: true },
    ] as unknown as ModelInfo[];
    try {
      toClaudeCatalog(garbage, SIGNED_IN_ACCOUNT);
      throw new Error("expected toClaudeCatalog to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  test("a garbage model row's error message names the model's value", () => {
    const garbage = [{ value: "sonnet" /* displayName and description missing */ }] as unknown as ModelInfo[];
    expect(() => toClaudeCatalog(garbage, SIGNED_IN_ACCOUNT)).toThrow(/"sonnet"/);
  });

  test("an empty model list is a protocol error, not an empty catalog", () => {
    expect(() => toClaudeCatalog([], SIGNED_IN_ACCOUNT)).toThrow(AgentCatalogError);
    try {
      toClaudeCatalog([], SIGNED_IN_ACCOUNT);
      throw new Error("expected toClaudeCatalog to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  test("a garbage model row is a protocol error", () => {
    const garbage = [{ value: "sonnet" /* displayName and description missing */ }] as unknown as ModelInfo[];
    try {
      toClaudeCatalog(garbage, SIGNED_IN_ACCOUNT);
      throw new Error("expected toClaudeCatalog to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  test("a non-array model list is a protocol error", () => {
    const garbage = { not: "an array" } as unknown as ModelInfo[];
    try {
      toClaudeCatalog(garbage, SIGNED_IN_ACCOUNT);
      throw new Error("expected toClaudeCatalog to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });
});

// This mapping rests on undocumented SDK behavior: sdk.d.ts makes no promise that a spawn
// error's `.code` survives onto the rejection classifyClaudeCatalogFailure receives. These
// tests are what makes an SDK bump that stops forwarding `.code` fail loudly here instead of
// quietly downgrading every "executable not found" case to the generic "spawn-failed" reason.
describe("classifyClaudeCatalogFailure", () => {
  test("an ENOENT code maps to executable-not-found and chains the cause", () => {
    const original = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const classified = classifyClaudeCatalogFailure(original);
    expect(classified).toBeInstanceOf(AgentCatalogError);
    expect(classified.reason).toBe("executable-not-found");
    expect(classified.cause).toBe(original);
  });

  test("a different code maps to spawn-failed and chains the cause", () => {
    // EACCES is deliberately not its own reason (see the comment on classifyClaudeCatalogFailure):
    // catalog.ts only offers two reasons at this stage, so it collapses into spawn-failed same
    // as every other non-ENOENT code.
    const original = Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" });
    const classified = classifyClaudeCatalogFailure(original);
    expect(classified).toBeInstanceOf(AgentCatalogError);
    expect(classified.reason).toBe("spawn-failed");
    expect(classified.cause).toBe(original);
  });

  test("an error with no code at all maps to spawn-failed and chains the cause", () => {
    const original = new Error("died before the handshake completed");
    const classified = classifyClaudeCatalogFailure(original);
    expect(classified).toBeInstanceOf(AgentCatalogError);
    expect(classified.reason).toBe("spawn-failed");
    expect(classified.cause).toBe(original);
  });
});
