import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSectionOutputSchema, type AgentQueryRequest } from "../src/agent/contract.js";

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

const { CodexAgentClient, detectCodexExecutable, resolveAmbientCodexHome } =
  await import("../src/agent/codex-client.js");

// Every client built without an apiKey materialises the ambient auth.json into its isolated
// home. Left to resolve on its own that means the developer's real ~/.codex/auth.json, so the
// whole file runs against an empty fixture home instead: a test run must never read, link or
// write live credentials.
const ambientFixtures: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const emptyAmbientHome = ambientHome();

afterAll(() => {
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
    expect(detectCodexExecutable(undefined, { USERPROFILE: "C:\\Users\\someone" })).toBeUndefined();
  });
});

describe("CodexAgentClient construction", () => {
  test("reports it cannot use vault tools", () => {
    expect(new CodexAgentClient().supportsVaultTools).toBe(false);
  });

  test("does not construct the underlying Codex client until the first query", () => {
    new CodexAgentClient();
    // CodexOptions.config (which carries base_instructions) is constructor-level, not
    // per-thread, so construction must wait for the first request.systemPrompt.
    expect(constructedWith).toHaveLength(0);
  });

  test("forwards codexPathOverride and apiKey to the Codex constructor on first query", async () => {
    const client = new CodexAgentClient({ codexPathOverride: "C:\\tools\\codex.exe", apiKey: "sk-test" });
    await client.query(baseRequest());
    expect(constructedWith[0]!.codexPathOverride).toBe("C:\\tools\\codex.exe");
    expect(constructedWith[0]!.apiKey).toBe("sk-test");
  });

  test("omits both constructor credentials when neither is given", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest());
    expect(constructedWith[0]).not.toHaveProperty("codexPathOverride");
    expect(constructedWith[0]).not.toHaveProperty("apiKey");
  });

  test("constructs the underlying Codex client only once, reusing it across repeated calls", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest());
    await client.query(baseRequest());
    expect(constructedWith).toHaveLength(1);
  });
});

describe("CodexAgentClient happy path", () => {
  test("starts a fresh thread and returns the structured output and thread id", async () => {
    const client = new CodexAgentClient();
    const response = await client.query(baseRequest());
    expect(response.sessionId).toBe("thread-1");
    expect(response.structuredOutput).toEqual({ sections: [] });
    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
  });

  test("every call is read-only, skips the git-repo check, and never asks for approval", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest());
    const options = startThreadCalls[0]!.options;
    expect(options.sandboxMode).toBe("read-only");
    expect(options.skipGitRepoCheck).toBe(true);
    expect(options.approvalPolicy).toBe("never");
  });

  test("workingDirectory is a scratch directory, never request.cwd", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest({ cwd: "C:\\some\\vault" }));
    const workingDirectory = startThreadCalls[0]!.options.workingDirectory as string;
    expect(workingDirectory).not.toBe("C:\\some\\vault");
    expect(workingDirectory.length).toBeGreaterThan(0);
  });

  test("forwards the output schema on the turn", async () => {
    const outputSchema = buildSectionOutputSchema();
    const client = new CodexAgentClient();
    await client.query(baseRequest({ outputSchema }));
    expect(runStreamedCalls[0]!.options.outputSchema).toBe(outputSchema);
  });

  test("reuses the same scratch directory across repeated calls on one instance", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest());
    await client.query(baseRequest());
    expect(startThreadCalls).toHaveLength(2);
    expect(startThreadCalls[1]!.options.workingDirectory).toBe(startThreadCalls[0]!.options.workingDirectory);
  });

  test("passes the system prompt as base_instructions on the underlying Codex client's config, once, reused across calls", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest({ systemPrompt: "SAFE PREAMBLE\n\nGuidance." }));
    await client.query(baseRequest({ systemPrompt: "SAFE PREAMBLE\n\nGuidance." }));
    expect(constructedWith).toHaveLength(1);
    const config = constructedWith[0]!.config as { base_instructions: string };
    expect(config.base_instructions).toBe("SAFE PREAMBLE\n\nGuidance.");
  });

  // Defence in depth, not a boundary: a live probe executed a shell command through an
  // operator MCP server with this flag set. The isolated CODEX_HOME is what closes that path,
  // and the tests below are the ones that cover the boundary.
  test("pins config.features.shell_tool to false", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest());
    const config = constructedWith[0]!.config as { features: { shell_tool: boolean } };
    expect(config.features).toEqual({ shell_tool: false });
  });

  test("pins the model on the Codex config when the caller supplies one", async () => {
    const client = new CodexAgentClient({ model: "gpt-5.6-codex" });
    await client.query(baseRequest());
    expect((constructedWith[0]!.config as { model?: string }).model).toBe("gpt-5.6-codex");
  });

  test("omits the model entirely when the caller supplies none, inheriting the CLI default", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest());
    expect(constructedWith[0]!.config).not.toHaveProperty("model");
  });

  test("replaces ambient CODEX_HOME with a fresh isolated config root", async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "C:\\operator\\.codex";
    try {
      const client = new CodexAgentClient({ apiKey: "sk-test" });
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
    const client = new CodexAgentClient();
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
    const client = new CodexAgentClient();
    const response = await client.query(baseRequest());
    expect(response.structuredOutput).toEqual({ sections: [] });
  });

  test("treats a non-JSON agent_message as invalid output with a diagnostic, not a thrown error", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-4" };
      yield { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "not json" } };
      yield { type: "turn.completed", usage: ZERO_USAGE };
    })();
    const client = new CodexAgentClient();
    const response = await client.query(baseRequest());
    expect(response.structuredOutput).toBeUndefined();
    expect(response.diagnostics?.[0]).toMatch(/not valid JSON/);
  });

  test("reads request.tools but never forwards it, since Codex has no tool allowlist", async () => {
    const client = new CodexAgentClient();
    await client.query(baseRequest({ tools: ["Read", "Glob", "Grep"] }));
    expect(startThreadCalls[0]!.options).not.toHaveProperty("tools");
    expect(runStreamedCalls[0]!.options).not.toHaveProperty("tools");
  });

  test("refuses to start on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new CodexAgentClient();
    await expect(client.query(baseRequest({ signal: controller.signal }))).rejects.toThrow(/abort/i);
    expect(startThreadCalls).toHaveLength(0);
    expect(constructedWith).toHaveLength(0);
  });
});

describe("CodexAgentClient session resume", () => {
  test("resumes an existing thread when sessionId is present", async () => {
    const client = new CodexAgentClient();
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
    const client = new CodexAgentClient();
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
    const client = new CodexAgentClient();
    await expect(client.query(baseRequest())).rejects.toThrow(/sandbox denied the write/);
  });

  test("a bare error event maps to AgentQueryError too", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-x" };
      yield { type: "error", message: "connection reset" };
    })();
    const client = new CodexAgentClient();
    await expect(client.query(baseRequest())).rejects.toThrow(/connection reset/);
  });

  test("a stream that never emits an agent_message is a query error, not a silent undefined output", async () => {
    events = () => (async function* () {
      yield { type: "thread.started", thread_id: "thread-y" };
      yield { type: "turn.completed", usage: ZERO_USAGE };
    })();
    const client = new CodexAgentClient();
    await expect(client.query(baseRequest())).rejects.toThrow(/stream ended without an agent message/);
  });

  test("a stream with no thread.started event fails loudly rather than returning an empty session id", async () => {
    events = () => (async function* () {
      yield agentMessageEvent({ sections: [] });
    })();
    const client = new CodexAgentClient();
    await expect(client.query(baseRequest())).rejects.toThrow(/no thread id/);
  });
});

describe("CodexAgentClient abort forwarding", () => {
  test("forwards the request signal into TurnOptions.signal for real cancellation", async () => {
    const controller = new AbortController();
    const client = new CodexAgentClient();
    await client.query(baseRequest({ signal: controller.signal }));
    expect(runStreamedCalls[0]!.options.signal).toBe(controller.signal);
  });

  test("omits signal from TurnOptions when the request has none", async () => {
    const client = new CodexAgentClient();
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
    const client = new CodexAgentClient({ ambientCodexHome: ambient });
    await client.query(baseRequest());
    const isolated = isolatedHomeOf(constructedWith[0]!);
    expect(isolated).not.toBe(ambient);
    expect(isolated).not.toBe(join(homedir(), ".codex"));
    expect(readFileSync(join(isolated, "auth.json"), "utf8")).toBe(`{"tokens":{"access_token":"fixture"}}`);
    // Only auth.json crosses: config.toml, skills and MCP servers stay behind, which is the
    // whole reason the isolated home is the boundary.
    expect(existsSync(join(isolated, "config.toml"))).toBe(false);
  });

  test("a token rotated inside the isolated home writes through to the user's own auth.json", async () => {
    // The security property the hard link exists for. A copy would leave the user's CLI holding
    // a refresh token Codex already spent, i.e. logged out of a tool they never touched. Both
    // paths are under the OS temp directory here, so the cross-volume copy fallback is not in
    // play; if it were, this failing is the correct signal rather than a flake to silence.
    const ambient = ambientHome(`{"tokens":{"refresh_token":"old"}}`);
    const client = new CodexAgentClient({ ambientCodexHome: ambient });
    await client.query(baseRequest());
    const isolated = isolatedHomeOf(constructedWith[0]!);
    writeFileSync(join(isolated, "auth.json"), `{"tokens":{"refresh_token":"rotated"}}`);
    expect(readFileSync(join(ambient, "auth.json"), "utf8")).toBe(`{"tokens":{"refresh_token":"rotated"}}`);
  });

  test("an absent ambient auth.json is not an error: the query still runs", async () => {
    const client = new CodexAgentClient({ ambientCodexHome: ambientHome() });
    const response = await client.query(baseRequest());
    expect(response.sessionId).toBe("thread-1");
    expect(existsSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"))).toBe(false);
  });

  test("an ambient home that does not exist at all is not an error either", async () => {
    const client = new CodexAgentClient({ ambientCodexHome: join(tmpdir(), "shorthand-codex-absent-home") });
    await expect(client.query(baseRequest())).resolves.toBeDefined();
  });

  test("skips the ambient login entirely when an apiKey is supplied", async () => {
    const ambient = ambientHome(`{"tokens":{"access_token":"fixture"}}`);
    const client = new CodexAgentClient({ apiKey: "sk-test", ambientCodexHome: ambient });
    await client.query(baseRequest());
    expect(existsSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"))).toBe(false);
  });

  test("the ambientCodexHome option beats an ambient CODEX_HOME", async () => {
    process.env.CODEX_HOME = ambientHome(`{"tokens":{"access_token":"from-env"}}`);
    const client = new CodexAgentClient({ ambientCodexHome: ambientHome(`{"tokens":{"access_token":"from-option"}}`) });
    await client.query(baseRequest());
    expect(readFileSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"), "utf8"))
      .toContain("from-option");
  });

  test("falls back to the ambient CODEX_HOME when no option is given", async () => {
    process.env.CODEX_HOME = ambientHome(`{"tokens":{"access_token":"from-env"}}`);
    const client = new CodexAgentClient();
    await client.query(baseRequest());
    expect(readFileSync(join(isolatedHomeOf(constructedWith[0]!), "auth.json"), "utf8"))
      .toContain("from-env");
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
      const client = new CodexAgentClient();
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
      const client = new CodexAgentClient();
      await client.query(baseRequest());
      await client.query(baseRequest());
      expect(registrations).toBe(1);
    } finally {
      process.once = originalOnce;
    }
  });
});
