import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { buildSectionOutputSchema, type AgentQueryRequest } from "../src/agent/contract.js";

// Captured before any spyOn() below replaces these module exports, so mocked
// implementations that only need to intercept one specific call can delegate every other
// call to the real filesystem behaviour instead of reimplementing it.
const realRealpath = fsPromises.realpath;
const realMkdtemp = fsPromises.mkdtemp;

type CodexEventLike = Record<string, unknown>;
type ThreadCall = { options: Record<string, unknown> };

const startThreadCalls: ThreadCall[] = [];
const resumeThreadCalls: (ThreadCall & { threadId: string })[] = [];
const runStreamedCalls: { prompt: string; options: Record<string, unknown> }[] = [];
const constructedWith: Record<string, unknown>[] = [];
let events = (): AsyncIterable<CodexEventLike> => defaultEvents();

// Real @openai/codex-sdk (0.149.1) shape, verified against the installed .d.ts, NOT guessed:
// - Structured output arrives as an `item.completed` event wrapping an `agent_message` item
//   whose `text` field is a JSON string (TurnCompletedEvent itself carries only token usage).
// - `runStreamed()` resolves to `{ events: AsyncGenerator<ThreadEvent> }` — the events must be
//   destructured out of the resolved value, the resolved value is not itself async-iterable.
const ZERO_USAGE = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};

function agentMessageEvent(payload: unknown): CodexEventLike {
  return { type: "item.completed", item: { id: "item-1", type: "agent_message", text: JSON.stringify(payload) } };
}

function defaultEvents(): AsyncIterable<CodexEventLike> {
  return (async function* () {
    yield { type: "thread.started", thread_id: "thread-1" };
    yield agentMessageEvent({ sections: [] });
    yield { type: "turn.completed", usage: ZERO_USAGE };
  })();
}

class FakeThread {
  runStreamed(prompt: string, options: Record<string, unknown>) {
    runStreamedCalls.push({ prompt, options });
    return Promise.resolve({ events: events() });
  }
}

class FakeCodex {
  constructor(options: Record<string, unknown> = {}) {
    constructedWith.push(options);
  }
  startThread(options: Record<string, unknown>) {
    startThreadCalls.push({ options });
    return new FakeThread();
  }
  resumeThread(threadId: string, options: Record<string, unknown>) {
    resumeThreadCalls.push({ threadId, options });
    return new FakeThread();
  }
}

mock.module("@openai/codex-sdk", () => ({ Codex: FakeCodex }));

const { CodexAgentClient, detectCodexExecutable, resolveAmbientCodexHome, resolveCodexBaseUrl, resolveCodexModel } =
  await import("../src/agent/codex-client.js");
type CodexAgentClientOptions = ConstructorParameters<typeof CodexAgentClient>[0];

// Every client built without an apiKey materialises the ambient auth.json into its isolated
// home. Left to resolve on its own that means the developer's real ~/.codex/auth.json, so the
// whole file runs against an empty fixture home instead: a test run must never read, link or
// write live credentials.
const ambientFixtures: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const emptyAmbientHome = ambientHome();

// process.once("exit") never fires under bun's test runner (measured: the OS temp dir climbed
// by dozens of "shorthand-codex-*" runtime roots across one run before this existed), so every
// client that reaches query() must be disposed explicitly or its runtime root leaks for the
// life of the machine, not just the test run. Routing every construction through this helper
// means no test can forget to register for cleanup.
const clients: InstanceType<typeof CodexAgentClient>[] = [];
function newClient(options?: CodexAgentClientOptions): InstanceType<typeof CodexAgentClient> {
  const client = new CodexAgentClient(options);
  clients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const path of ambientFixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

beforeEach(() => {
  startThreadCalls.length = 0;
  resumeThreadCalls.length = 0;
  runStreamedCalls.length = 0;
  constructedWith.length = 0;
  events = () => defaultEvents();
  process.env.CODEX_HOME = emptyAmbientHome;
});

function ambientHome(auth?: string): string {
  const path = mkdtempSync(join(tmpdir(), "shorthand-codex-ambient-"));
  ambientFixtures.push(path);
  if (auth !== undefined) writeFileSync(join(path, "auth.json"), auth);
  return path;
}

function isolatedHomeOf(construction: Record<string, unknown>): string {
  return (construction.env as Record<string, string>).CODEX_HOME!;
}

function baseRequest(overrides: Partial<AgentQueryRequest> = {}): AgentQueryRequest {
  return {
    prompt: overrides.prompt ?? "Write the sections.",
    systemPrompt: overrides.systemPrompt ?? "You maintain the AI section.",
    tools: overrides.tools ?? [],
    settingSources: [],
    maxTurns: overrides.maxTurns ?? 4,
    outputSchema: overrides.outputSchema ?? buildSectionOutputSchema(),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
    ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
  };
}

// PATH detection reads the real filesystem, so every case below builds its own directory tree
// and injects it as PATH. A test run must never depend on a Codex actually being installed on
// the machine running it, and must never assert against the developer's own PATH.
const pathFixtures: string[] = [];
const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
const isWindows = process.platform === "win32";

function pathDirectory(...entries: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "shorthand-codex-path-"));
  pathFixtures.push(directory);
  // 0o755 because the POSIX branch requires the execute bit; the mode is inert on Windows,
  // where the `.exe` extension is what stands in for it.
  for (const entry of entries) writeFileSync(join(directory, entry), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return directory;
}

afterAll(() => {
  for (const path of pathFixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("detectCodexExecutable", () => {
  test("returns undefined when nothing is configured and PATH is empty", () => {
    // The SDK cannot cover for this: findCodexPath() only does an npm resolve, never a PATH
    // search, so undefined here means no Codex at all rather than "let the SDK look".
    expect(detectCodexExecutable(undefined, {})).toBeUndefined();
    expect(detectCodexExecutable(undefined, { PATH: "" })).toBeUndefined();
  });

  test("returns undefined when PATH holds nothing that looks like Codex", () => {
    expect(detectCodexExecutable(undefined, { PATH: pathDirectory("notes.txt") })).toBeUndefined();
  });

  test("finds a Codex on PATH with no configuration at all", () => {
    const directory = pathDirectory(codexBinaryName);
    expect(detectCodexExecutable(undefined, { PATH: directory })).toBe(join(directory, codexBinaryName));
  });

  test("walks PATH in order so the user's own precedence wins", () => {
    const first = pathDirectory(codexBinaryName);
    const second = pathDirectory(codexBinaryName);
    expect(detectCodexExecutable(undefined, { PATH: [first, second].join(delimiter) }))
      .toBe(join(first, codexBinaryName));
  });

  test("skips PATH entries that do not hold Codex rather than giving up at the first miss", () => {
    const empty = pathDirectory();
    const real = pathDirectory(codexBinaryName);
    expect(detectCodexExecutable(undefined, { PATH: [empty, real].join(delimiter) }))
      .toBe(join(real, codexBinaryName));
  });

  test("reads PATH whatever case the key was set in, as Windows spells it `Path`", () => {
    const directory = pathDirectory(codexBinaryName);
    expect(detectCodexExecutable(undefined, { Path: directory })).toBe(join(directory, codexBinaryName));
  });

  // Windows-only by nature: on POSIX the npm shim is a shell script with the execute bit and is
  // perfectly spawnable, so there is nothing to exclude.
  test.skipIf(!isWindows)("never returns an npm shim, which spawn cannot execute without a shell", () => {
    // codex/codex.cmd/codex.ps1 with no codex.exe is exactly what an `npm i -g @openai/codex`
    // install leaves on PATH. spawnSync("codex.cmd") fails EINVAL, so returning one would trade
    // a clean "no Codex found" for a failure at the first enhancement pass.
    const shimsOnly = pathDirectory("codex", "codex.cmd", "codex.ps1");
    expect(detectCodexExecutable(undefined, { PATH: shimsOnly })).toBeUndefined();
  });

  test.skipIf(!isWindows)("passes over a shim directory to reach a real codex.exe later in PATH", () => {
    const shimsOnly = pathDirectory("codex", "codex.cmd", "codex.ps1");
    const real = pathDirectory("codex.exe");
    expect(detectCodexExecutable(undefined, { PATH: [shimsOnly, real].join(delimiter) }))
      .toBe(join(real, "codex.exe"));
  });

  test("ignores a directory that merely shares the executable's name", () => {
    const directory = mkdtempSync(join(tmpdir(), "shorthand-codex-path-"));
    pathFixtures.push(directory);
    mkdirSync(join(directory, codexBinaryName));
    expect(detectCodexExecutable(undefined, { PATH: directory })).toBeUndefined();
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

  test("SHORTHAND_CODEX_EXE beats whatever is on PATH", () => {
    const onPath = pathDirectory(codexBinaryName);
    const configured = join(pathDirectory(codexBinaryName), codexBinaryName);
    expect(detectCodexExecutable(undefined, { SHORTHAND_CODEX_EXE: configured, PATH: onPath })).toBe(configured);
  });

  test("a bare command name is looked up on PATH, not mangled into <cwd>/codex by resolve()", () => {
    const directory = pathDirectory(codexBinaryName);
    const found = detectCodexExecutable("codex", { PATH: directory });
    expect(found).toBe(join(directory, codexBinaryName));
    expect(found).not.toBe(resolve("codex"));
  });

  test("a bare command name that PATH cannot resolve is handed back verbatim, not discarded", () => {
    // Returning undefined would send the SDK to its own npm lookup and silently run a different
    // Codex than the one the operator named; resolve() would invent a <cwd> path that is worse.
    expect(detectCodexExecutable("codex", {})).toBe("codex");
  });

  test("does not fall back to a hardcoded install path the way detectClaudeExecutable does", () => {
    expect(detectCodexExecutable(undefined, { USERPROFILE: "C:\\Users\\someone" })).toBeUndefined();
  });
});

describe("resolveCodexModel", () => {
  test("returns undefined when nothing is configured, inheriting the installed CLI's default", () => {
    expect(resolveCodexModel(undefined, {})).toBeUndefined();
  });

  test("resolves an explicit override", () => {
    expect(resolveCodexModel("gpt-5.6-codex", {})).toBe("gpt-5.6-codex");
  });

  test("falls back to SHORTHAND_CODEX_MODEL when no override is passed", () => {
    expect(resolveCodexModel(undefined, { SHORTHAND_CODEX_MODEL: "gpt-5.6-codex" })).toBe("gpt-5.6-codex");
  });

  test("an explicit override wins over the environment variable", () => {
    expect(resolveCodexModel("from-flag", { SHORTHAND_CODEX_MODEL: "from-env" })).toBe("from-flag");
  });

  test("an empty value is treated as unset", () => {
    expect(resolveCodexModel("", { SHORTHAND_CODEX_MODEL: "" })).toBeUndefined();
  });
});

describe("resolveCodexBaseUrl", () => {
  test("returns undefined when nothing is configured, inheriting the installed CLI's default", () => {
    expect(resolveCodexBaseUrl(undefined, {})).toBeUndefined();
  });

  test("resolves an explicit override", () => {
    expect(resolveCodexBaseUrl("https://compliance.example/v1", {})).toBe("https://compliance.example/v1");
  });

  test("falls back to SHORTHAND_CODEX_BASE_URL when no override is passed", () => {
    expect(resolveCodexBaseUrl(undefined, { SHORTHAND_CODEX_BASE_URL: "https://env.example/v1" }))
      .toBe("https://env.example/v1");
  });

  test("an explicit override wins over the environment variable", () => {
    expect(resolveCodexBaseUrl("https://flag.example/v1", { SHORTHAND_CODEX_BASE_URL: "https://env.example/v1" }))
      .toBe("https://flag.example/v1");
  });

  test("an empty value is treated as unset", () => {
    expect(resolveCodexBaseUrl("", { SHORTHAND_CODEX_BASE_URL: "" })).toBeUndefined();
  });
});

describe("CodexAgentClient construction", () => {
  test("reports it cannot use vault tools", () => {
    expect(newClient().supportsVaultTools).toBe(false);
  });

  test("does not construct the underlying Codex client until the first query", () => {
    newClient();
    // CodexOptions.config (which carries base_instructions) is constructor-level, not
    // per-thread, so construction must wait for the first request.systemPrompt.
    expect(constructedWith).toHaveLength(0);
  });

  test("forwards codexPathOverride and apiKey to the Codex constructor on first query", async () => {
    const client = newClient({ codexPathOverride: "C:\\tools\\codex.exe", apiKey: "sk-test" });
    await client.query(baseRequest());
    expect(constructedWith[0]!.codexPathOverride).toBe("C:\\tools\\codex.exe");
    expect(constructedWith[0]!.apiKey).toBe("sk-test");
  });

  test("omits both constructor credentials when neither is given", async () => {
    const client = newClient();
    await client.query(baseRequest());
    expect(constructedWith[0]).not.toHaveProperty("codexPathOverride");
    expect(constructedWith[0]).not.toHaveProperty("apiKey");
  });

  test("constructs the underlying Codex client only once, reusing it across repeated calls", async () => {
    const client = newClient();
    await client.query(baseRequest());
    await client.query(baseRequest());
    expect(constructedWith).toHaveLength(1);
  });
});

describe("CodexAgentClient happy path", () => {
  test("starts a fresh thread and returns the structured output and thread id", async () => {
    const client = newClient();
    const response = await client.query(baseRequest());
    expect(response.sessionId).toBe("thread-1");
    expect(response.structuredOutput).toEqual({ sections: [] });
    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
  });

  test("every call is read-only, skips the git-repo check, and never asks for approval", async () => {
    const client = newClient();
    await client.query(baseRequest());
    const options = startThreadCalls[0]!.options;
    expect(options.sandboxMode).toBe("read-only");
    expect(options.skipGitRepoCheck).toBe(true);
    expect(options.approvalPolicy).toBe("never");
  });

  test("workingDirectory is a scratch directory, never request.cwd", async () => {
    const client = newClient();
    await client.query(baseRequest({ cwd: "C:\\some\\vault" }));
    const workingDirectory = startThreadCalls[0]!.options.workingDirectory as string;
    expect(workingDirectory).not.toBe("C:\\some\\vault");
    expect(workingDirectory.length).toBeGreaterThan(0);
  });

  test("forwards the output schema on the turn", async () => {
    const outputSchema = buildSectionOutputSchema();
    const client = newClient();
    await client.query(baseRequest({ outputSchema }));
    expect(runStreamedCalls[0]!.options.outputSchema).toBe(outputSchema);
  });

  test("reuses the same scratch directory across repeated calls on one instance", async () => {
    const client = newClient();
    await client.query(baseRequest());
    await client.query(baseRequest());
    expect(startThreadCalls).toHaveLength(2);
    expect(startThreadCalls[1]!.options.workingDirectory).toBe(startThreadCalls[0]!.options.workingDirectory);
  });

  test("passes the system prompt as base_instructions on the underlying Codex client's config, once, reused across calls", async () => {
    const client = newClient();
    await client.query(baseRequest({ systemPrompt: "SAFE PREAMBLE\n\nGuidance." }));
    await client.query(baseRequest({ systemPrompt: "SAFE PREAMBLE\n\nGuidance." }));
    expect(constructedWith).toHaveLength(1);
    const config = constructedWith[0]!.config as { base_instructions: string };
    expect(config.base_instructions).toBe("SAFE PREAMBLE\n\nGuidance.");
  });

  // Defence in depth, not a boundary: a live probe executed a shell command through an
  // operator MCP server with shell_tool/unified_exec both set. The isolated CODEX_HOME is what
  // closes that path for direct exec; apps: false is what closes the built-in codex_apps MCP
  // surface the isolated home does NOT close on its own (verified live A/B — see the comment
  // on #ensureCodex); browser_use* is pinned as defence-in-depth on a source read, not a live
  // A/B. Exact-object equality, not a subset match: this suite has already been bitten twice by
  // a `toMatchObject`-shaped assertion that stayed green after the flag it was meant to protect
  // was removed, so a new flag silently dropped from the source must fail this test too.
  test("pins every config.features flag closing a known Codex MCP/browser gap to false", async () => {
    const client = newClient();
    await client.query(baseRequest());
    const config = constructedWith[0]!.config as { features: Record<string, boolean> };
    expect(config.features).toEqual({
      shell_tool: false,
      unified_exec: false,
      apps: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
    });
  });

  // Model moved to the SDK's typed ThreadOptions.model (per-thread), not
  // CodexOptions.config (constructor-level): config.base_instructions is the only field that
  // legitimately belongs there, since it has no per-thread equivalent in the SDK.
  test("pins the model on ThreadOptions when the caller supplies one", async () => {
    const client = newClient({ model: "gpt-5.6-codex" });
    await client.query(baseRequest());
    expect(constructedWith[0]!.config).not.toHaveProperty("model");
    expect((startThreadCalls[0]!.options as { model?: string }).model).toBe("gpt-5.6-codex");
  });

  test("omits the model entirely when the caller supplies none, inheriting the CLI default", async () => {
    const client = newClient();
    await client.query(baseRequest());
    expect(constructedWith[0]!.config).not.toHaveProperty("model");
    expect(startThreadCalls[0]!.options).not.toHaveProperty("model");
  });

  test("pins reasoning effort on ThreadOptions only when supplied", async () => {
    const configured = newClient({ modelReasoningEffort: "xhigh" });
    await configured.query(baseRequest());
    expect(startThreadCalls[0]!.options.modelReasoningEffort).toBe("xhigh");

    const inherited = newClient();
    await inherited.query(baseRequest());
    expect(startThreadCalls[1]!.options).not.toHaveProperty("modelReasoningEffort");
  });

  // CodexAgentClientOptions.modelReasoningEffort is `string`, not the static
  // CodexReasoningEffort union, precisely so a value catalog.ts's AgentModel.efforts reported
  // from the live Codex app-server reaches the SDK even when the pinned npm SDK's
  // ModelReasoningEffort union has not caught up to that CLI version yet. An effort string
  // outside CODEX_REASONING_EFFORTS must still compile and flow through to the ThreadOptions
  // boundary unchanged — a static union here would make this exact case a type error.
  test("a reasoning effort outside the static CODEX_REASONING_EFFORTS union still reaches ThreadOptions", async () => {
    const futureEffort = "extreme";
    const client = newClient({ modelReasoningEffort: futureEffort });
    await client.query(baseRequest());
    expect(startThreadCalls[0]!.options.modelReasoningEffort).toBe(futureEffort);
  });

  test("replaces ambient CODEX_HOME with a fresh isolated config root", async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "C:\\operator\\.codex";
    try {
      const client = newClient({ apiKey: "sk-test" });
      await client.query(baseRequest());
      const environment = constructedWith[0]!.env as Record<string, string>;
      expect(environment.CODEX_HOME).not.toBe("C:\\operator\\.codex");
      expect(environment.CODEX_HOME).toContain("shorthand-codex-");
      expect(Object.keys(environment).filter((key) => key.toUpperCase() === "CODEX_HOME"))
        .toEqual(["CODEX_HOME"]);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  test("parses the agent_message item's text as the structured output", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-2" };
      yield agentMessageEvent({ sections: [{ heading: "H", markdown: "m" }] });
      yield { type: "turn.completed", usage: ZERO_USAGE };
    })();
    const client = newClient();
    const response = await client.query(baseRequest());
    expect(response.structuredOutput).toEqual({ sections: [{ heading: "H", markdown: "m" }] });
  });

  test("ignores non-agent_message items (e.g. shell exec) when looking for the output", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-3" };
      yield { type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "echo hi", aggregated_output: "hi\n", status: "completed" } };
      yield agentMessageEvent({ sections: [] });
      yield { type: "turn.completed", usage: ZERO_USAGE };
    })();
    const client = newClient();
    const response = await client.query(baseRequest());
    expect(response.structuredOutput).toEqual({ sections: [] });
  });

  test("treats a non-JSON agent_message as invalid output with a diagnostic, not a thrown error", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-4" };
      yield { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "not json" } };
      yield { type: "turn.completed", usage: ZERO_USAGE };
    })();
    const client = newClient();
    const response = await client.query(baseRequest());
    expect(response.structuredOutput).toBeUndefined();
    expect(response.diagnostics?.[0]).toMatch(/not valid JSON/);
  });

  test("reads request.tools but never forwards it, since Codex has no tool allowlist", async () => {
    const client = newClient();
    await client.query(baseRequest({ tools: ["Read", "Glob", "Grep"] }));
    expect(startThreadCalls[0]!.options).not.toHaveProperty("tools");
    expect(runStreamedCalls[0]!.options).not.toHaveProperty("tools");
  });

  test("refuses to start on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = newClient();
    await expect(client.query(baseRequest({ signal: controller.signal }))).rejects.toThrow(/abort/i);
    expect(startThreadCalls).toHaveLength(0);
    expect(constructedWith).toHaveLength(0);
  });
});

describe("CodexAgentClient session resume", () => {
  test("resumes an existing thread when sessionId is present", async () => {
    const client = newClient();
    const first = await client.query(baseRequest());
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: first.sessionId };
      yield agentMessageEvent({ sections: [{ heading: "H", markdown: "m" }] });
      yield { type: "turn.completed", usage: ZERO_USAGE };
    })();
    const second = await client.query(baseRequest({ sessionId: first.sessionId }));
    expect(resumeThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls[0]!.threadId).toBe(first.sessionId);
    expect(startThreadCalls).toHaveLength(1);
    expect(second.structuredOutput).toEqual({ sections: [{ heading: "H", markdown: "m" }] });
  });

  test("an empty sessionId starts a fresh thread rather than resuming", async () => {
    const client = newClient();
    await client.query(baseRequest({ sessionId: "" }));
    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
  });
});

describe("CodexAgentClient failure mapping", () => {
  test("turn.failed maps to AgentQueryError carrying the failure message", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-x" };
      yield { type: "turn.failed", error: { message: "sandbox denied the write" } };
    })();
    const client = newClient();
    await expect(client.query(baseRequest())).rejects.toThrow(/sandbox denied the write/);
  });

  test("a bare error event maps to AgentQueryError too", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-x" };
      yield { type: "error", message: "connection reset" };
    })();
    const client = newClient();
    await expect(client.query(baseRequest())).rejects.toThrow(/connection reset/);
  });

  test("a stream that never emits an agent_message is a query error, not a silent undefined output", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-y" };
      yield { type: "turn.completed", usage: ZERO_USAGE };
    })();
    const client = newClient();
    await expect(client.query(baseRequest())).rejects.toThrow(/stream ended without an agent message/);
  });

  test("a stream with no thread.started event fails loudly rather than returning an empty session id", async () => {
    events = () => (async function* () {
      yield agentMessageEvent({ sections: [] });
    })();
    const client = newClient();
    await expect(client.query(baseRequest())).rejects.toThrow(/no thread id/);
  });
});

describe("CodexAgentClient abort forwarding", () => {
  test("forwards the request signal into TurnOptions.signal for real cancellation", async () => {
    const controller = new AbortController();
    const client = newClient();
    await client.query(baseRequest({ signal: controller.signal }));
    expect(runStreamedCalls[0]!.options.signal).toBe(controller.signal);
  });

  test("omits signal from TurnOptions when the request has none", async () => {
    const client = newClient();
    await client.query(baseRequest());
    expect(runStreamedCalls[0]!.options).not.toHaveProperty("signal");
  });
});

describe("resolveAmbientCodexHome", () => {
  test("an explicit option wins over the environment", () => {
    expect(resolveAmbientCodexHome("/fixture/.codex", { CODEX_HOME: "/env/.codex" }))
      .toBe("/fixture/.codex");
  });

  test("the environment wins over the home directory, whatever case it was set in", () => {
    expect(resolveAmbientCodexHome(undefined, { codex_home: "/env/.codex" })).toBe("/env/.codex");
  });

  test("falls back to ~/.codex when neither is set", () => {
    // Compares the resolved path only; nothing here opens it, so a developer's real
    // credentials are neither read nor linked by running the suite.
    expect(resolveAmbientCodexHome(undefined, {})).toBe(join(homedir(), ".codex"));
  });

  test("an empty value is treated as unset rather than as the current directory", () => {
    expect(resolveAmbientCodexHome("", { CODEX_HOME: "" })).toBe(join(homedir(), ".codex"));
  });
});

describe("CodexAgentClient ambient auth", () => {
  test("materialises the ambient auth.json into the isolated home, which is not the ambient home", async () => {
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    const client = newClient({ ambientCodexHome: ambient });
    await client.query(baseRequest());
    const isolated = isolatedHomeOf(constructedWith[0]!);
    expect(isolated).not.toBe(ambient);
    expect(isolated).not.toBe(join(homedir(), ".codex"));
    expect(readFileSync(join(isolated, "auth.json"), "utf8")).toBe(`{"tokens":{"access_token":"fixture"}}`);
    // Asserting the isolated home's exact directory listing, not just the absence of
    // config.toml by name: CODEX_HOME is read for more than config.toml (AGENTS.md, skills/,
    // plugins/), and a version of this code that additionally wrote e.g. an mcp.json full of
    // MCP servers into the isolated home would still pass a config.toml-only check. Only
    // auth.json is meant to cross — that is the whole reason the isolated home is a boundary.
    expect(readdirSync(isolated).sort()).toEqual(["auth.json"]);
  });

  test("a token rotated inside the isolated home writes through to the user's own auth.json", async () => {
    // The security property the hard link exists for. A copy would leave the user's CLI holding
    // a refresh token Codex already spent, i.e. logged out of a tool they never touched. Both
    // paths are under the OS temp directory here, so the cross-volume copy fallback is not in
    // play; if it were, this failing is the correct signal rather than a flake to silence.
    //
    // Not proof that OAuth refresh is safe: writeFileSync below opens with O_TRUNC and writes
    // into the existing inode, which is exactly the "rewrites in place" behaviour the hard
    // link depends on — verified only for `codex login --with-api-key`, per the comment on
    // linkAmbientCodexAuth. If Codex's OAuth refresh instead writes a temp file and renames it
    // over auth.json, that would silently break the link, and this test's use of writeFileSync
    // would not catch it: it isn't exercising a temp+rename, it's assuming the same in-place
    // write this test is meant to be evidence for.
    const ambient = ambientHome(`{"tokens":{"refresh_token":"old"}}`);
    const client = newClient({ ambientCodexHome: ambient });
    await client.query(baseRequest());
    const isolated = isolatedHomeOf(constructedWith[0]!);
    writeFileSync(join(isolated, "auth.json"), `{"tokens":{"refresh_token":"rotated"}}`);
    expect(readFileSync(join(ambient, "auth.json"), "utf8")).toBe(`{"tokens":{"refresh_token":"rotated"}}`);
  });

  test("an absent ambient auth.json is not an error: the query still runs, and the isolated home stays empty", async () => {
    const client = newClient({ ambientCodexHome: ambientHome() });
    const response = await client.query(baseRequest());
    expect(response.sessionId).toBe("thread-1");
    const isolated = isolatedHomeOf(constructedWith[0]!);
    expect(existsSync(join(isolated, "auth.json"))).toBe(false);
    // Same exact-contents check as the materialises-auth test above, for the no-login case:
    // nothing should land in the isolated home when there was nothing to bring across.
    expect(readdirSync(isolated)).toEqual([]);
  });

  test("an ambient home that does not exist at all is not an error either", async () => {
    const client = newClient({ ambientCodexHome: join(tmpdir(), "shorthand-codex-absent-home") });
    await expect(client.query(baseRequest())).resolves.toBeDefined();
  });

  test("skips the ambient login entirely when an apiKey is supplied", async () => {
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    const client = newClient({ apiKey: "sk-test", ambientCodexHome: ambient });
    await client.query(baseRequest());
    expect(existsSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"))).toBe(false);
  });

  test("the ambientCodexHome option beats an ambient CODEX_HOME", async () => {
    process.env.CODEX_HOME = ambientHome(`{"tokens":{"access_token":"from-env"}}`);
    const client = newClient({ ambientCodexHome: ambientHome(`{"tokens":{"access_token":"from-option"}}`) });
    await client.query(baseRequest());
    expect(readFileSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"), "utf8"))
      .toContain("from-option");
  });

  test("falls back to the ambient CODEX_HOME when no option is given", async () => {
    process.env.CODEX_HOME = ambientHome(`{"tokens":{"access_token":"from-env"}}`);
    const client = newClient();
    await client.query(baseRequest());
    expect(readFileSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"), "utf8"))
      .toContain("from-env");
  });

  // realpath is resolved before link()/copyFile() ever see the path (see linkAmbientCodexAuth
  // in src/agent/codex-client.ts). Mocking realpath's return value stands in for what a real
  // symlink would do without needing OS symlink-creation privilege, which this Windows
  // checkout does not have outside Developer Mode (fs.symlinkSync fails with EPERM here) —
  // the same dereferencing therefore runs whether the redirection comes from a real symlink
  // or, as here, a mocked realpath.
  test("dereferences auth.json through realpath before hardlinking, so a relative symlink resolves before crossing into the isolated home", async () => {
    const ambient = ambientHome();
    const rawTarget = join(ambient, "auth.json");
    const realAuthDirectory = mkdtempSync(join(tmpdir(), "shorthand-codex-real-auth-"));
    ambientFixtures.push(realAuthDirectory);
    const realAuthPath = join(realAuthDirectory, "codex-auth.json");
    writeFileSync(realAuthPath, `{"tokens":{"access_token":"through-symlink"}}`);
    const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation((async (path: string) => {
      if (path === rawTarget) return realAuthPath;
      return realRealpath(path);
    }) as typeof fsPromises.realpath);
    try {
      const client = newClient({ ambientCodexHome: ambient });
      await client.query(baseRequest());
      const isolated = isolatedHomeOf(constructedWith[0]!);
      expect(readFileSync(join(isolated, "auth.json"), "utf8")).toBe(`{"tokens":{"access_token":"through-symlink"}}`);
      // Write-through still holds after dereferencing: a link() called with `rawTarget` (the
      // pre-fix behaviour) would either fail outright (no file exists there) or, on a platform
      // where hardlinking a symlink is possible, land on a name that does not resolve from the
      // isolated home's directory — either way this mutation would fail here.
      writeFileSync(join(isolated, "auth.json"), `{"tokens":{"access_token":"rotated"}}`);
      expect(readFileSync(realAuthPath, "utf8")).toBe(`{"tokens":{"access_token":"rotated"}}`);
    } finally {
      realpathSpy.mockRestore();
    }
  });
});

describe("CodexAgentClient auth link fallback", () => {
  test("falls back to copy when the volume cannot hardlink at all (ENOTSUP), not just when it needs a different one (EXDEV)", async () => {
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    const linkSpy = spyOn(fsPromises, "link")
      .mockImplementation(async () => { throw Object.assign(new Error("not supported"), { code: "ENOTSUP" }); });
    try {
      const client = newClient({ ambientCodexHome: ambient });
      await client.query(baseRequest());
      const isolated = isolatedHomeOf(constructedWith[0]!);
      expect(readFileSync(join(isolated, "auth.json"), "utf8")).toBe(`{"tokens":{"access_token":"fixture"}}`);
    } finally {
      linkSpy.mockRestore();
    }
  });

  test("a link failure with an unrecognised error code is a real fault and is not silently degraded to a copy", async () => {
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    const linkSpy = spyOn(fsPromises, "link")
      .mockImplementation(async () => { throw Object.assign(new Error("disk on fire"), { code: "EIO" }); });
    try {
      const client = newClient({ ambientCodexHome: ambient });
      await expect(client.query(baseRequest())).rejects.toThrow(/disk on fire/);
    } finally {
      linkSpy.mockRestore();
    }
  });

  test("an ambient CODEX_HOME that resolves to a file, not a directory, behaves like no login found rather than crashing", async () => {
    const ambient = ambientHome();
    const rawTarget = join(ambient, "auth.json");
    const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation((async (path: string) => {
      if (path === rawTarget) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      return realRealpath(path);
    }) as typeof fsPromises.realpath);
    try {
      const client = newClient({ ambientCodexHome: ambient });
      const response = await client.query(baseRequest());
      expect(response.sessionId).toBe("thread-1");
      expect(existsSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"))).toBe(false);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  test("a copy that loses a TOCTOU race after realpath already proved the file existed is treated as no login found, not a crash", async () => {
    // Not dead code: realpath proved `source` existed, but a concurrent `codex login`/`logout`
    // can still unlink it before this copy runs. This is that race, forced deterministically.
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    const linkSpy = spyOn(fsPromises, "link")
      .mockImplementation(async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); });
    const copySpy = spyOn(fsPromises, "copyFile")
      .mockImplementation(async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
    try {
      const client = newClient({ ambientCodexHome: ambient });
      const response = await client.query(baseRequest());
      expect(response.sessionId).toBe("thread-1");
      expect(existsSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"))).toBe(false);
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
    }
  });
});

describe("CodexAgentClient runtime root failure handling", () => {
  test("registers exit cleanup for the runtime root even when auth linking fails outright, so a failure does not leak it", async () => {
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    const createdRoots: string[] = [];
    const mkdtempSpy = spyOn(fsPromises, "mkdtemp").mockImplementation((async (prefix: string) => {
      const root = await realMkdtemp(prefix);
      createdRoots.push(root);
      return root;
    }) as typeof fsPromises.mkdtemp);
    const linkSpy = spyOn(fsPromises, "link")
      .mockImplementation(async () => { throw Object.assign(new Error("boom"), { code: "EIO" }); });
    const originalOnce = process.once.bind(process);
    let exitHandler: (() => void) | undefined;
    process.once = ((event: string, handler: () => void) => {
      if (event === "exit") exitHandler = handler;
      return process;
    }) as typeof process.once;
    try {
      const client = newClient({ ambientCodexHome: ambient });
      await expect(client.query(baseRequest())).rejects.toThrow(/boom/);
      // Reproduces the reviewer's probe directly: before the fix, a failure here left
      // "exit handlers registered: 0, orphaned dirs: 1" — the root existed on disk with
      // nothing ever registered to remove it.
      const root = createdRoots.at(-1)!;
      expect(existsSync(root)).toBe(true);
      expect(exitHandler).toBeDefined();
      exitHandler!();
      expect(existsSync(root)).toBe(false);
    } finally {
      process.once = originalOnce;
      linkSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }
  });

  test("a rejected runtime-dir build does not stay cached: the next query() gets a fresh root instead of replaying the same failure forever", async () => {
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    let calls = 0;
    const linkSpy = spyOn(fsPromises, "link").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("transient"), { code: "EIO" });
      // Second attempt degrades to a copy instead of repeating the failure, so success here
      // is not an accident of the mock but proof the client actually retried the auth step.
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    });
    try {
      const client = newClient({ ambientCodexHome: ambient });
      // Before the fix, #runtimeDirs cached the rejected promise from `??=`, so this second
      // call would reject with the same "transient" error instead of building a fresh root.
      await expect(client.query(baseRequest())).rejects.toThrow(/transient/);
      const response = await client.query(baseRequest());
      expect(response.sessionId).toBe("thread-1");
      expect(calls).toBe(2);
    } finally {
      linkSpy.mockRestore();
    }
  });
});

describe("CodexAgentClient dispose", () => {
  test("removes the runtime root immediately, without waiting for process exit", async () => {
    // Not newClient(): disposed explicitly within the test rather than by the shared
    // afterAll, so the assertion below is checking this test's own cleanup call, not the
    // file-wide safety net.
    const client = new CodexAgentClient();
    await client.query(baseRequest());
    const workingDirectory = startThreadCalls.at(-1)!.options.workingDirectory as string;
    expect(existsSync(workingDirectory)).toBe(true);
    await client.dispose();
    expect(existsSync(workingDirectory)).toBe(false);
  });

  test("is a safe no-op when query() was never called", async () => {
    const client = new CodexAgentClient();
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  test("retention archives session state without auth or the scratch workspace", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "shorthand-codex-retained-test-"));
    ambientFixtures.push(archiveRoot);
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    const client = new CodexAgentClient({
      ambientCodexHome: ambient,
      retainSessionHistory: true,
      retainedSessionsDirectory: archiveRoot,
    });
    await client.query(baseRequest());
    const isolatedHome = isolatedHomeOf(constructedWith.at(-1)!);
    mkdirSync(join(isolatedHome, "sessions"));
    writeFileSync(join(isolatedHome, "sessions", "thread.jsonl"), "retained");
    const workingDirectory = startThreadCalls.at(-1)!.options.workingDirectory as string;

    await client.dispose();

    const archives = readdirSync(archiveRoot);
    expect(archives).toHaveLength(1);
    const archive = join(archiveRoot, archives[0]!);
    expect(readFileSync(join(archive, "sessions", "thread.jsonl"), "utf8")).toBe("retained");
    expect(existsSync(join(archive, "auth.json"))).toBe(false);
    expect(existsSync(workingDirectory)).toBe(false);
  });
});

describe("CodexAgentClient scratch directory cleanup", () => {
  test("removes the scratch directory best-effort when the process exits", async () => {
    const originalOnce = process.once.bind(process);
    let exitHandler: (() => void) | undefined;
    process.once = ((event: string, handler: () => void) => {
      if (event === "exit") exitHandler = handler;
      return process;
    }) as typeof process.once;
    try {
      const client = newClient();
      await client.query(baseRequest());
      const workingDirectory = startThreadCalls[0]!.options.workingDirectory as string;
      expect(existsSync(workingDirectory)).toBe(true);
      expect(exitHandler).toBeDefined();
      exitHandler!();
      expect(existsSync(workingDirectory)).toBe(false);
    } finally {
      process.once = originalOnce;
    }
  });

  test("registers the exit cleanup only once even across repeated calls", async () => {
    let registrations = 0;
    const originalOnce = process.once.bind(process);
    process.once = ((event: string, handler: () => void) => {
      if (event === "exit") registrations += 1;
      return originalOnce(event, handler);
    }) as typeof process.once;
    try {
      const client = newClient();
      await client.query(baseRequest());
      await client.query(baseRequest());
      expect(registrations).toBe(1);
    } finally {
      process.once = originalOnce;
    }
  });
});
