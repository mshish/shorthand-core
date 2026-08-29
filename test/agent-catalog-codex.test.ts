import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { AgentCatalogError } from "../src/agent/catalog.js";
import {
  listCodexModels,
  toCodexCatalog,
  type CodexAccountReadResult,
  type CodexCatalogModel,
  type ListCodexModelsOptions,
} from "../src/agent/codex-app-server.js";

const fixturePath = fileURLToPath(new URL("./fixtures/codex-model-catalog.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  data: CodexCatalogModel[];
  nextCursor: string | null;
};
const fixtureIds = fixture.data.map((model) => model.id);

const fakeServerPath = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

const SIGNED_IN: CodexAccountReadResult = { account: { email: "dev@example.com" } };
const SIGNED_OUT: CodexAccountReadResult = { account: null };

// Every end-to-end test below spawns a real node process running the fake app-server fixture.
// Tracked here rather than trusted to `listCodexModels`'s own cleanup, so a test that fails an
// assertion before the function returns still cannot leak a process past the test run.
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

function baseOptions(mode: string, overrides: Partial<ListCodexModelsOptions> = {}): ListCodexModelsOptions {
  return {
    // PATH detection reads the real filesystem; an empty environment plus a bare command name
    // means detectCodexExecutable hands "codex" back verbatim (see its own "unresolvable" test
    // in codex-client.test.ts) rather than finding a real Codex the test machine happens to
    // have installed. spawnFn below never uses this value — it always launches the fixture.
    codexPathOverride: "codex",
    environment: {},
    timeoutMs: 2_000,
    spawnFn: (_command, _args, options) => {
      const child = spawn(process.execPath, [fakeServerPath, mode], { ...options, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
    ...overrides,
  };
}

describe("toCodexCatalog", () => {
  test("maps the fixture's ids, display names, description, and default effort", () => {
    const catalog = toCodexCatalog(fixture.data, SIGNED_IN);
    const sol = catalog.models.find((model) => model.id === "gpt-5.6-sol");
    expect(sol).toEqual({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "low",
    });
  });

  test("flattens supportedReasoningEfforts from {reasoningEffort, description} objects to bare strings", () => {
    const catalog = toCodexCatalog(fixture.data, SIGNED_IN);
    const luna = catalog.models.find((model) => model.id === "gpt-5.6-luna");
    // The fixture row's own field is still objects; only the mapped catalog is flattened.
    const rawLuna = fixture.data.find((model) => model.id === "gpt-5.6-luna");
    expect(typeof rawLuna?.supportedReasoningEfforts?.[0]).toBe("object");
    expect(luna?.efforts.every((effort) => typeof effort === "string")).toBe(true);
    expect(luna?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("gpt-5.4 yields exactly low/medium/high/xhigh — no max, no ultra", () => {
    const catalog = toCodexCatalog(fixture.data, SIGNED_IN);
    const gpt54 = catalog.models.find((model) => model.id === "gpt-5.4");
    expect(gpt54?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("preserves catalog order rather than sorting it", () => {
    const catalog = toCodexCatalog(fixture.data, SIGNED_IN);
    expect(catalog.models.map((model) => model.id)).toEqual(fixtureIds);
  });

  test("signedIn is true and account is the email when account/read names an account", () => {
    const catalog = toCodexCatalog(fixture.data, SIGNED_IN);
    expect(catalog.signedIn).toBe(true);
    expect(catalog.account).toBe("dev@example.com");
  });

  test("signedIn is false and account is unset when account/read returns null", () => {
    const catalog = toCodexCatalog(fixture.data, SIGNED_OUT);
    expect(catalog.signedIn).toBe(false);
    expect(catalog).not.toHaveProperty("account");
  });

  test("filters a hidden model defensively, even though the server already excludes it", () => {
    const withHidden = [
      ...fixture.data,
      { id: "gpt-reserve", displayName: "Reserve", description: "Internal.", hidden: true },
    ];
    const catalog = toCodexCatalog(withHidden, SIGNED_IN);
    expect(catalog.models.some((model) => model.id === "gpt-reserve")).toBe(false);
  });
});

describe("listCodexModels", () => {
  test("throws executable-not-found when no codex can be located at all", async () => {
    try {
      await listCodexModels({ environment: {} });
      throw new Error("expected listCodexModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("executable-not-found");
    }
  });

  test(
    "runs the full handshake end to end: out-of-order responses and an interleaved notification " +
      "do not confuse the result",
    async () => {
      // The fixture answers account/read (id 3) before model/list (id 2), and interleaves an
      // unsolicited notification right after initialize — see fake-codex-app-server.mjs's
      // "normal" mode. A client that assumed response order matched request order, or that
      // tripped on the notification, would produce the wrong catalog or hang.
      const catalog = await listCodexModels(baseOptions("normal"));
      expect(catalog.signedIn).toBe(true);
      expect(catalog.account).toBe("dev@example.com");
      expect(catalog.models.map((model) => model.id)).toEqual(fixtureIds);
      const gpt54 = catalog.models.find((model) => model.id === "gpt-5.4");
      expect(gpt54?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    },
  );

  test("signedIn is false end to end when account/read returns null", async () => {
    const catalog = await listCodexModels(baseOptions("signed-out"));
    expect(catalog.signedIn).toBe(false);
    expect(catalog).not.toHaveProperty("account");
  });

  test("follows nextCursor pagination and preserves order across pages", async () => {
    const catalog = await listCodexModels(baseOptions("paginated"));
    expect(catalog.models.map((model) => model.id)).toEqual(fixtureIds);
  });

  test("a JSON-RPC error response on model/list produces a protocol AgentCatalogError", async () => {
    try {
      await listCodexModels(baseOptions("error"));
      throw new Error("expected listCodexModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  test("a line that is not valid JSON produces a protocol AgentCatalogError", async () => {
    try {
      await listCodexModels(baseOptions("garbage"));
      throw new Error("expected listCodexModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  test(
    "a response carrying { result, error: null } on the same message resolves instead of " +
      "crashing the handshake",
    async () => {
      // Regression for `parsed.error !== undefined`, which is true for `null` and used to throw
      // `TypeError: Cannot read properties of null (reading 'message')` synchronously inside the
      // stdout data handler — an uncaught exception there kills the whole host process, not just
      // this fetch.
      const catalog = await listCodexModels(baseOptions("null-error"));
      expect(catalog.models.map((model) => model.id)).toEqual(fixtureIds);
    },
  );

  test("a model/list result missing the data array produces a protocol AgentCatalogError, not spawn-failed", async () => {
    try {
      await listCodexModels(baseOptions("missing-data"));
      throw new Error("expected listCodexModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      // Confirmed regression: an unvalidated `page.data` throws `TypeError: page.data is not
      // iterable`, which classifyCodexCatalogFailure then reported as spawn-failed — telling the
      // caller the executable could not be spawned when the real problem was a shape mismatch.
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  test("an account/read result missing the account field produces a protocol AgentCatalogError", async () => {
    try {
      await listCodexModels(baseOptions("missing-account"));
      throw new Error("expected listCodexModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  test("an omitted nextCursor (not an explicit null) still terminates pagination", async () => {
    // `JSON.stringify({cursor: undefined})` serializes to `{}`, so a client that compared
    // `cursor !== null` rather than normalizing at the boundary would resend an empty params
    // object and refetch page 1 forever instead of stopping.
    const catalog = await listCodexModels(baseOptions("omitted-cursor"));
    expect(catalog.models.map((model) => model.id)).toEqual(fixtureIds);
  });

  test("a server repeating the same non-null cursor forever produces a protocol error, not a bare timeout", async () => {
    try {
      await listCodexModels(baseOptions("loop-cursor"));
      throw new Error("expected listCodexModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("protocol");
    }
  });

  test("a multi-byte character split across a stdout chunk boundary is not corrupted", async () => {
    const catalog = await listCodexModels(baseOptions("split-utf8"));
    const first = catalog.models[0];
    expect(first?.displayName).toBe(`${fixture.data[0]?.displayName} — Split`);
    expect(first?.displayName).not.toContain("�");
  });

  test("kills the child and throws a timeout error when the server never answers", async () => {
    let spawnedChild: ChildProcess | undefined;
    try {
      await listCodexModels({
        codexPathOverride: "codex",
        environment: {},
        timeoutMs: 200,
        spawnFn: (_command, _args, options) => {
          const child = spawn(process.execPath, [fakeServerPath, "hang"], { ...options, stdio: ["pipe", "pipe", "pipe"] });
          children.push(child);
          spawnedChild = child;
          return child;
        },
      });
      throw new Error("expected listCodexModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect((error as AgentCatalogError).reason).toBe("timeout");
    }
    // `finally` in listCodexModels calls child.kill() before the rejection reaches this catch,
    // and `killed` flips true synchronously on that call — no need to wait for actual exit.
    expect(spawnedChild?.killed).toBe(true);
  });
});
