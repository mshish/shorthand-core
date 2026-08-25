# Codex Agent Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third `AgentClient` implementation, `CodexAgentClient`, wrapping OpenAI's `@openai/codex-sdk`, selectable via `--backend codex` alongside the existing `claude` and `llm` backends — purely additive, no change to `AgentClient`, `AgentQueryRequest`/`AgentQueryResponse`, or `EnhanceRunner`.

**Architecture:** `AgentClient` is a deliberate port (`docs/DESIGN.md`, "The agent is a port too"). `CodexAgentClient` is a sibling implementation to `ClaudeAgentClient` (`src/agent/client.ts`) and `LlmAgentClient` (`src/agent/llm-client.ts`), living in its own new file `src/agent/codex-client.ts` so every import of the wrapped third-party SDK lives in exactly one file, matching the convention `llm-client.ts` already establishes. It never receives vault/note content (`supportsVaultTools = false`) because Codex has no tool-allowlist and no per-call approval hook — `sandboxMode: "read-only"` blocks an attempted write only after the model has already tried it, unlike Claude's `tools: []` + `canUseTool` deny-all, which never offers the tool at all.

**Tech Stack:** TypeScript, Bun (`bun:test`, `bun.mock.module`), Node.js 22, esbuild, `@openai/codex-sdk`.

**Spec:** `docs/superpowers/specs/2026-08-25-codex-agent-backend-design.md`

## Global Constraints

- No changes to `src/agent/contract.ts`, `AgentClient`, `AgentQueryRequest`/`AgentQueryResponse`, or `src/agent/runner.ts`.
- No changes to `pathToClaudeCodeExecutable` or any generalization of it.
- ACP is out of scope.
- `exactOptionalPropertyTypes: true` is on (`tsconfig.json`) — never assign a `T | undefined`-typed expression directly to an optional `field?: T`; use the spread-conditional pattern already established in `buildClaudeAgentOptions` (`src/agent/client.ts`): `...(value === undefined ? {} : { field: value })`.
- Every task must leave `bun test` and `bun run typecheck` green; `bun run build` and `bun run test:e2e` are exercised at the points noted and always at the final task.
- Follow this repo's established third-party-SDK test pattern: `mock.module("@openai/codex-sdk", () => ({...}))`, mirroring `test/llm-client.test.ts`'s `mock.module("ai", () => ({...}))` — register the mock, then dynamically `await import(...)` the module under test so it resolves against the mock.
- Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`); message explains *why*.
- **Task 1 resolves two genuinely unverified facts before any implementation code depends on them**: the exact mechanism for replacing Codex's system instructions (`base_instructions`), and the exact `ThreadEvent` field names for the thread id, the structured-output payload, and a failed turn's error message. Every later task's code listing uses the best-documented guess from the approved spec, called out inline wherever it rests on that guess — substitute the real names Task 1 finds if they differ.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `package.json` | Modify | Add `@openai/codex-sdk` dependency; add `--external:@openai/codex-sdk` to the `build` script |
| `src/agent/codex-client.ts` | Create | `CodexAgentClient`, `CodexAgentClientOptions`, `detectCodexExecutable` |
| `test/codex-client.test.ts` | Create | Full test coverage for the above, mocking `@openai/codex-sdk` |
| `src/index.ts` | Modify | Additive exports: `CodexAgentClient`, `detectCodexExecutable` |
| `bin/shorthand-notes.ts` | Modify | `selectAgent()` gets a `codex` branch; usage text; `KNOWN_FLAGS` gets `--codex-exe` |
| `test/cli.test.ts` | Modify | Cover the new `--backend codex` branch and the updated error message |
| `docs/DESIGN.md` | Modify | Scope the "no write tool" invariant per backend |
| `README.md` | Modify | Document `--backend codex` |

---

## Task 1 — Add `@openai/codex-sdk` and empirically verify its type surface

This is a research/spike task, not TDD: there is no behavior to test yet, only facts to pin down before Task 3 onward can write code against them.

**Files**
- Modify: `package.json` (dependency added by `bun add`)

**Steps**
1. Run `bun add @openai/codex-sdk` from the repo root. This updates `package.json` and `bun.lock`.
2. Locate the package's type declarations: `find node_modules/@openai/codex-sdk -name '*.d.ts'`.
3. Read the declaration file(s) and record, in writing (a scratch note is fine — does not need to be committed):
   - Does `CodexOptions` (the `Codex` constructor argument) declare `codexPathOverride?: string` and `apiKey?: string` under those exact names?
   - How does one replace Codex's built-in system instructions? Look for `baseInstructions`, `instructions`, `base_instructions`, or a raw `config`/`configOverrides` escape-hatch field on `ThreadOptions` or `CodexOptions`. Record whichever exists and its exact shape.
   - `ThreadOptions`'s exact field names for `workingDirectory`, `additionalDirectories`, `skipGitRepoCheck`, `sandboxMode`, `approvalPolicy`. Confirm there truly is no tool-allowlist field.
   - `TurnOptions`'s exact field names for `outputSchema` and `signal`.
   - The `ThreadEvent` union's exact shape: the field carrying the thread/session id on the started event (this plan guesses `thread_id`), the field carrying structured output on the completed event (guesses `output`), and the shape of a failed-turn/error event (guesses `{ type: "turn.failed", error: { message } }` and `{ type: "error", message }`).
4. If any of these differ from what Tasks 3–8 below assume, substitute the correct names into those tasks' code before writing it, not after.

**Gate**: `bun run typecheck`, `bun test` (both unaffected — nothing imports the package yet).

**Commit**
```
chore: add @openai/codex-sdk dependency

Pin the SDK the new Codex backend will wrap; no code depends on it yet.
Its installed type declarations are what this task's verification step
reads to confirm the exact field names the implementation tasks use.
```

---

## Task 2 — `detectCodexExecutable`

**Files**
- Create: `src/agent/codex-client.ts`
- Create: `test/codex-client.test.ts`

**Interfaces**
- Produces: `detectCodexExecutable(override?: string, environment?: NodeJS.ProcessEnv): string | undefined`

**TDD steps**

1. Write the failing test — create `test/codex-client.test.ts`:
```ts
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
```
2. Run `bun test test/codex-client.test.ts`. Verify failure: the import fails because `src/agent/codex-client.ts` does not exist yet.
3. Write the minimal implementation — create `src/agent/codex-client.ts`:
```ts
import { resolve } from "node:path";

export function detectCodexExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = override ?? environment.SHORTHAND_CODEX_EXE;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  // No hardcoded install-path fallback: unlike detectClaudeExecutable's
  // ~/.local/bin/claude.exe check, Codex's own installer layout on Windows/macOS/Linux is
  // unverified here, and guessing one would be exactly the kind of unverified assumption
  // this project's own "do not assume, empirically test" principle rules out.
  // Leaving this undefined delegates PATH/platform auto-detection to the Codex SDK.
  return undefined;
}
```
4. Run `bun test test/codex-client.test.ts`. Verify all five cases pass.

**Gate**: `bun test`, `bun run typecheck`.

**Commit**
```
feat(agent): add detectCodexExecutable

Mirrors detectClaudeExecutable's env-var override shape without
copying its hardcoded Windows install-path guess, which is unverified
for the Codex CLI's own installer.
```

---

## Task 3 — `CodexAgentClient` happy path (fresh thread)

**Files**
- Modify: `src/agent/codex-client.ts`
- Modify: `test/codex-client.test.ts`

**Interfaces**
- Consumes: `Codex` (from `@openai/codex-sdk`), `AgentClient`, `AgentQueryRequest`, `AgentQueryResponse`, `AgentQueryError` (from `./contract.js`)
- Produces: `class CodexAgentClient implements AgentClient { readonly supportsVaultTools = false; constructor(options?: CodexAgentClientOptions); query(request: AgentQueryRequest): Promise<AgentQueryResponse>; }`, `type CodexAgentClientOptions = Readonly<{ codexPathOverride?: string; apiKey?: string }>`

**TDD steps**

1. Write the failing test — rewrite the top of `test/codex-client.test.ts` to the dynamic-import-after-`mock.module` pattern (required because `mock.module` must register before the module under test is first imported), and add the happy-path suite:
```ts
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
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

const { CodexAgentClient, detectCodexExecutable } = await import("../src/agent/codex-client.js");

beforeEach(() => {
  startThreadCalls.length = 0;
  resumeThreadCalls.length = 0;
  runStreamedCalls.length = 0;
  constructedWith.length = 0;
  events = () => defaultEvents();
});

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

  test("omits both when neither is given, so a locally logged-in codex CLI session is reused", async () => {
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
```
2. Run `bun test test/codex-client.test.ts`. Verify failure: `CodexAgentClient` is not exported.
3. Write the minimal implementation — append to `src/agent/codex-client.ts` (the `detectCodexExecutable` function from Task 2 stays; move it to the bottom of the file so the class reads first):
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { AgentQueryError, type AgentClient, type AgentQueryRequest, type AgentQueryResponse } from "./contract.js";

type CodexEvent = Record<string, unknown>;

export type CodexAgentClientOptions = Readonly<{
  codexPathOverride?: string;
  apiKey?: string;
}>;

export class CodexAgentClient implements AgentClient {
  /**
   * Codex always offers shell-exec and apply_patch to the model — there is no allowlist to
   * withhold them the way ClaudeAgentClient's `tools: []` does. Never handing this client
   * vault content is the mitigation; see docs/DESIGN.md's per-backend "no write tool" scoping.
   */
  readonly supportsVaultTools = false;

  readonly #options: CodexAgentClientOptions;
  #codex: Codex | undefined;
  #scratchDir: Promise<string> | undefined;

  constructor(options: CodexAgentClientOptions = {}) {
    this.#options = options;
  }

  async query(request: AgentQueryRequest): Promise<AgentQueryResponse> {
    if (request.signal?.aborted === true) throw new AgentQueryError("Agent query aborted.");
    const codex = this.#ensureCodex(request.systemPrompt);
    const workingDirectory = await this.#ensureScratchDir();
    const threadOptions = {
      // Always the scratch directory this client owns, never request.cwd: this backend is
      // never handed vault content (supportsVaultTools = false), and this field is not read
      // from `request` at all, so nothing can wire a vault path through here by accident.
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only" as const,
      approvalPolicy: "never" as const,
      // request.tools is deliberately never read into this object: ThreadOptions has no
      // tool-allowlist field, so there is no way to keep shell-exec/apply_patch out of what
      // the model is offered the way Claude's `tools: []` does.
    };
    const thread = codex.startThread(threadOptions);
    const turnOptions = { outputSchema: request.outputSchema };
    // runStreamed() resolves to { events: AsyncGenerator<ThreadEvent> } — the resolved value
    // is not itself async-iterable, unlike the Claude Agent SDK's query() stream.
    const { events } = await thread.runStreamed(request.prompt, turnOptions);
    let sessionId: string | undefined;
    let structuredOutput: unknown;
    let diagnostics: string[] = [];
    for await (const rawEvent of events) {
      const event = rawEvent as CodexEvent;
      // The session id is stable for the life of the stream: capture it off the first
      // thread.started message seen and never overwrite it on later messages.
      if (sessionId === undefined && event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
      }
      // TurnCompletedEvent carries only token usage, not the answer. The answer is an
      // item.completed event wrapping an agent_message item; other item types (shell exec,
      // file changes, MCP tool calls) can appear in the same stream and must be ignored here.
      if (event.type === "item.completed") {
        const item = event.item as CodexEvent | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          // outputSchema is meant to be hard-enforced at the API level, so `text` should
          // always be valid JSON here — but "should always be" is exactly what this
          // project's own "do not assume, empirically test" principle distrusts. A parse
          // failure is treated as an invalid pass (structuredOutput left undefined,
          // diagnostics carried for the corrective retry in queryForSections), the same way
          // ClaudeAgentClient's schema-exhaustion path is — not thrown, which would skip the
          // corrective retry entirely.
          try {
            structuredOutput = JSON.parse(item.text);
          } catch {
            diagnostics = [`Codex agent_message text was not valid JSON: ${item.text.slice(0, 200)}`];
          }
        }
      }
    }
    if (sessionId === undefined) throw new Error("Codex SDK returned no thread id.");
    return { structuredOutput, sessionId, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
  }

  #ensureCodex(systemPrompt: string): Codex {
    // Lazy: CodexOptions.config (which carries base_instructions, replacing Codex's default
    // system prompt — see docs/superpowers/specs/2026-08-25-codex-agent-backend-design.md) is
    // constructor-level, not per-thread, so the Codex instance can't be built until the first
    // call's systemPrompt is known. Built once and reused after that, which relies on
    // request.systemPrompt being identical across every call on one client instance — already
    // true today (EnhanceRunnerOptions.guidance is fixed at construction — see AGENTS.md "the
    // enhancement prompt is split, deliberately"). If that ever stops being true, this
    // silently keeps serving the FIRST call's instructions to every later call.
    this.#codex ??= new Codex({
      ...(this.#options.codexPathOverride === undefined ? {} : { codexPathOverride: this.#options.codexPathOverride }),
      ...(this.#options.apiKey === undefined ? {} : { apiKey: this.#options.apiKey }),
      config: { base_instructions: systemPrompt },
    });
    return this.#codex;
  }

  #ensureScratchDir(): Promise<string> {
    this.#scratchDir ??= mkdtemp(join(tmpdir(), "shorthand-codex-"));
    return this.#scratchDir;
  }
}

export function detectCodexExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = override ?? environment.SHORTHAND_CODEX_EXE;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return undefined;
}
```
4. Run `bun test test/codex-client.test.ts`. Verify all cases pass.

**Gate**: `bun test`, `bun run typecheck`.

**Commit**
```
feat(agent): add CodexAgentClient happy-path query

Wraps @openai/codex-sdk as a sibling AgentClient to ClaudeAgentClient
and LlmAgentClient: a scratch working directory this client owns
(never request.cwd), read-only/no-approval thread options, and a
lazily-constructed Codex instance whose config.base_instructions
carries systemPrompt (config is constructor-level in this SDK, so
construction waits for the first call's systemPrompt, then is reused).
```

---

## Task 4 — Session resume

**Files**
- Modify: `src/agent/codex-client.ts`
- Modify: `test/codex-client.test.ts`

**Interfaces**
- Consumes: `Codex#resumeThread(threadId, threadOptions)`

**TDD steps**

1. Write the failing test — add to `test/codex-client.test.ts`:
```ts
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
```
2. Run `bun test test/codex-client.test.ts`. Verify failure: both calls hit `startThread`, so `resumeThreadCalls` is empty in the first test.
3. Write the minimal implementation — in `query()`, replace:
```ts
const thread = codex.startThread(threadOptions);
```
with:
```ts
const thread = typeof request.sessionId === "string" && request.sessionId.length > 0
  ? codex.resumeThread(request.sessionId, threadOptions)
  : codex.startThread(threadOptions);
```
(`Codex#startThread`/`#resumeThread` are synchronous in the real SDK, returning a `Thread` directly — no `await` here; the `await` stays on `thread.runStreamed(...)` below, unchanged.)
4. Run `bun test test/codex-client.test.ts`. Verify all cases pass.

**Gate**: `bun test`, `bun run typecheck`.

**Commit**
```
feat(agent): resume an existing Codex thread when sessionId is present

Matches the request.sessionId -> resumeThread / absent -> startThread
branching the design specifies, mirroring how ClaudeAgentClient's
`resume` flag works.
```

---

## Task 5 — Failure mapping

**Files**
- Modify: `src/agent/codex-client.ts`
- Modify: `test/codex-client.test.ts`

**Interfaces**
- Produces: turn/error events map to a thrown `AgentQueryError`; a stream with no completed turn is a query error, not a silent `undefined` output.

**TDD steps**

1. Write the failing test — add to `test/codex-client.test.ts`:
```ts
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
```
2. Run `bun test test/codex-client.test.ts`. Verify failure on the first three (nothing throws today; the fourth already passes from Task 3).
3. Write the minimal implementation — in `query()`'s streaming loop, add a `sawAgentMessage` flag and the `turn.failed`/`error` branch:
```ts
let sessionId: string | undefined;
let structuredOutput: unknown;
let diagnostics: string[] = [];
let sawAgentMessage = false;
for await (const rawEvent of events) {
  const event = rawEvent as CodexEvent;
  if (sessionId === undefined && event.type === "thread.started" && typeof event.thread_id === "string") {
    sessionId = event.thread_id;
  }
  if (event.type === "item.completed") {
    const item = event.item as CodexEvent | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      sawAgentMessage = true;
      try {
        structuredOutput = JSON.parse(item.text);
      } catch {
        diagnostics = [`Codex agent_message text was not valid JSON: ${item.text.slice(0, 200)}`];
      }
    }
  }
  if (event.type === "turn.failed" || event.type === "error") {
    throw new AgentQueryError(turnFailureMessage(event));
  }
}
if (sessionId === undefined) throw new Error("Codex SDK returned no thread id.");
if (!sawAgentMessage) throw new AgentQueryError("Codex SDK stream ended without an agent message.");
return { structuredOutput, sessionId, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
```
Add the helper below the class:
```ts
function turnFailureMessage(event: CodexEvent): string {
  const error = event.error;
  if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return typeof event.message === "string" ? event.message : `Codex SDK turn failed (${String(event.type)}).`;
}
```
4. Run `bun test test/codex-client.test.ts`. Verify all cases pass, including the previously-passing suites (regression check).

**Gate**: `bun test`, `bun run typecheck`.

**Commit**
```
feat(agent): map Codex turn.failed/error events to AgentQueryError

Mirrors ClaudeAgentClient.query's is_error handling so the two
implementations read as siblings: a failed or errored turn ends the
pass loudly, and a stream that never completes a turn is a query
error rather than a silently-absent structured output.
```

---

## Task 6 — Abort forwarding

**Files**
- Modify: `src/agent/codex-client.ts`
- Modify: `test/codex-client.test.ts`

**Interfaces**
- Produces: `request.signal` forwarded into `TurnOptions.signal`.

**TDD steps**

1. Write the failing test — add to `test/codex-client.test.ts`:
```ts
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
```
2. Run `bun test test/codex-client.test.ts`. Verify failure on the first case: `runStreamedCalls[0]!.options.signal` is `undefined`, not the controller's signal.
3. Write the minimal implementation — replace:
```ts
const turnOptions = { outputSchema: request.outputSchema };
```
with:
```ts
const turnOptions = {
  outputSchema: request.outputSchema,
  // The SDK forwards this straight into child_process.spawn's own `signal`, so this is real
  // cancellation, not cooperative — unlike ClaudeAgentClient, which has to call
  // stream.interrupt() from an abort listener because the Agent SDK has no signal option.
  ...(request.signal === undefined ? {} : { signal: request.signal }),
};
```
4. Run `bun test test/codex-client.test.ts`. Verify both cases pass.

**Gate**: `bun test`, `bun run typecheck`.

**Commit**
```
feat(agent): forward the request signal into Codex TurnOptions

The SDK forwards it directly into the underlying spawn's own signal,
so this is real process cancellation rather than a cooperative flag.
```

---

## Task 7 — Best-effort scratch-directory cleanup on process exit

**Files**
- Modify: `src/agent/codex-client.ts`
- Modify: `test/codex-client.test.ts`

**TDD steps**

1. Write the failing test — add to `test/codex-client.test.ts` (add `existsSync` to the file's `node:fs` imports alongside the existing `node:fs/promises` import):
```ts
import { existsSync } from "node:fs";

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
```
2. Run `bun test test/codex-client.test.ts`. Verify failure: `process.once` is never called with `"exit"`, so `exitHandler` stays `undefined`.
3. Write the minimal implementation — add to `src/agent/codex-client.ts`'s top-level imports:
```ts
import { rmSync } from "node:fs";
```
Add two private fields alongside the existing ones:
```ts
#cleanupRegistered = false;
#resolvedScratchDir: string | undefined;
```
Replace `#ensureScratchDir`:
```ts
#ensureScratchDir(): Promise<string> {
  this.#scratchDir ??= mkdtemp(join(tmpdir(), "shorthand-codex-")).then((dir) => {
    this.#resolvedScratchDir = dir;
    this.#registerCleanup();
    return dir;
  });
  return this.#scratchDir;
}

#registerCleanup(): void {
  if (this.#cleanupRegistered) return;
  this.#cleanupRegistered = true;
  // `exit` handlers must run synchronously, so async `rm` cannot be awaited here — this is
  // best-effort only, matching "reused for the life of the instance" in the design doc. A
  // hard kill (SIGKILL) skips it entirely, same as any other exit-handler cleanup in Node.
  process.once("exit", () => {
    if (this.#resolvedScratchDir !== undefined) {
      try { rmSync(this.#resolvedScratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
}
```
4. Run `bun test test/codex-client.test.ts`. Verify both cases pass.

**Gate**: `bun test`, `bun run typecheck`.

**Commit**
```
feat(agent): best-effort remove the Codex scratch directory on exit

Registered once per instance, the first time the scratch directory is
created. Synchronous rmSync, since `exit` handlers cannot await.
```

---

## Task 8 — Export `CodexAgentClient`/`detectCodexExecutable` from `src/index.ts`

**Files**
- Modify: `src/index.ts` — insert immediately after the existing line `export { ClaudeAgentClient, detectClaudeExecutable } from "./agent/client.js";`

**Interfaces**
- Produces: `export { CodexAgentClient, detectCodexExecutable } from "./agent/codex-client.js";`

**Steps**

There is no dedicated test for the export list's contents in this repo. This task is verified by Task 9's import succeeding under `tsc`, so treat it as a small, self-contained additive change proven correct by the next task.

1. Modify `src/index.ts`: insert immediately after `export { ClaudeAgentClient, detectClaudeExecutable } from "./agent/client.js";`:
```ts

export { CodexAgentClient, detectCodexExecutable } from "./agent/codex-client.js";
```
2. Run `bun run typecheck`. Verify it still passes.
3. Run `bun test`. Verify the full suite is unaffected (regression check).

**Gate**: `bun test`, `bun run typecheck`.

**Commit**
```
feat(agent): export CodexAgentClient and detectCodexExecutable

Additive only, alongside the existing ClaudeAgentClient/
detectClaudeExecutable and LlmAgentClient exports — no existing
export changes shape, so this does not touch obsidian-shorthand.
```

---

## Task 9 — Wire `--backend codex` into `bin/shorthand-notes.ts`

**Files**
- Modify: `bin/shorthand-notes.ts` (the `shorthand-core` import block; `usage()`; `KNOWN_FLAGS`; `selectAgent`)
- Modify: `test/cli.test.ts`

**Interfaces**
- Consumes: `CodexAgentClient`, `detectCodexExecutable` from `"shorthand-core"` (resolvable per Task 8)
- Produces: `selectAgent()` accepts `--backend codex`; `--codex-exe <path>` / `SHORTHAND_CODEX_EXE` resolve the executable

**TDD steps**

1. Write the failing test — add to `test/cli.test.ts`, inside the existing `describe("--backend selection", ...)` block (after the existing `--claude`/`--backend llm` test), and import `CodexAgentClient` alongside the existing `ClaudeAgentClient`/`LlmAgentClient` imports at the top of the file:
```ts
import { CodexAgentClient } from "../src/agent/codex-client.js";
```
```ts
    test("parses --backend codex and selects the Codex backend", async () => {
      const result = await selectAgent(["--backend", "codex"], {});
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(CodexAgentClient);
    });

    test("--codex-exe is resolved into the Codex client's codexPathOverride via detectCodexExecutable", async () => {
      const result = await selectAgent(["--backend", "codex", "--codex-exe", "C:\\tools\\codex.exe"], {});
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(CodexAgentClient);
    });

    test("rejects --claude combined with --backend codex", async () => {
      await expect(selectAgent(["--backend", "codex", "--claude", "C:\\fake\\claude.exe"], {}))
        .rejects.toThrow("--claude cannot be combined with --backend codex");
    });
```
Also update the existing unknown-backend test (`"--backend must be claude or llm."`) to the new three-way message:
```ts
    test("an unknown --backend value is a usage error, not a runtime one", async () => {
      await expect(selectAgent(["--backend", "bogus"], {})).rejects.toThrow("--backend must be claude, llm, or codex.");
    });
```
2. Run `bun test test/cli.test.ts`. Verify failure: `--backend codex` currently throws `"--backend must be claude or llm."`, and the updated unknown-backend assertion no longer matches the current message.
3. Write the minimal implementation:
   - In the `shorthand-core` import block, add `CodexAgentClient` and `detectCodexExecutable`, alongside `ClaudeAgentClient`/`detectClaudeExecutable` (keep every other existing import in that block — this is an insertion, not a rewrite):
```ts
import {
  ClaudeAgentClient,
  CodexAgentClient,
  DEFAULT_CONFIG,
  detectClaudeExecutable,
  detectCodexExecutable,
  detectShorthandExecutable,
  EnhanceRunner,
  LlmAgentClient,
  llmCredentialsPath,
  readLlmCredentials,
  SidecarWriter,
  StreamClient,
  TranscriptStore,
  enhancementDelta,
  type AgentClient,
  type AgentTier,
  type ExitDiagnosis,
  type NoteSink,
  type PassOutcome,
  type Section,
} from "shorthand-core";
```
   - In `KNOWN_FLAGS`, add `"--codex-exe"` (keep every existing entry):
```ts
const KNOWN_FLAGS = new Set([
  "--note", "--vault", "--sidecar", "--shorthand", "--fake-stream", "--no-reconnect",
  "--title", "--json", "--expect-hash", "--force", "--enhance", "--transcript",
  "--tier", "--dry-run", "--agent-stub", "--claude", "--sink", "--backend", "--codex-exe",
]);
```
   - In `usage()`, extend both usage lines to add `|codex` and `[--codex-exe <path>]`:
```ts
function usage(message?: string): number {
  if (message !== undefined) console.error(message);
  console.error(
    "Usage:\n  shorthand-notes capture --note <meeting-note.md> [--vault <path>] [--sidecar <transcript.md>] [--shorthand <path>] [--fake-stream [script-path]] [--no-reconnect] [--enhance] [--sink markdown|google] [--backend claude|llm|codex] [--agent-stub <script>] [--claude <path>] [--codex-exe <path>]\n  shorthand-notes enhance --note <path> --transcript <path> [--vault <path>] [--tier tick|link] [--sink markdown|google] [--backend claude|llm|codex] [--dry-run] [--agent-stub <script>] [--claude <path>] [--codex-exe <path>]\n  shorthand-notes init-note --vault <path> --note <path> [--title <text>] [--sidecar <path>]\n  shorthand-notes read-block --note <path> [--vault <path>]\n  shorthand-notes set-sections --note <path> [--vault <path>] --json <file> (--expect-hash <sha256> | --force)",
  );
  return 2;
}
```
   - In `selectAgent()`, replace the body from the `backendArg` check onward. Note the `codexOverride` line: it calls `detectCodexExecutable` FIRST and only spreads the result into the constructor options if defined — never `{ codexPathOverride: possiblyUndefined }` directly, because `exactOptionalPropertyTypes: true` rejects assigning a `string | undefined` value to an optional `string` field (see Global Constraints):
```ts
  const backendArg = argumentValue(args, "--backend") ?? "claude";
  if (backendArg !== "claude" && backendArg !== "llm" && backendArg !== "codex") {
    throw new ArgumentError("--backend must be claude, llm, or codex.");
  }
  if (backendArg === "claude") {
    return { ok: true, agent: new ClaudeAgentClient() };
  }
  if (backendArg === "codex") {
    if (argumentValue(args, "--claude") !== undefined) {
      throw new ArgumentError("--claude cannot be combined with --backend codex; the Codex backend never launches a Claude Code executable.");
    }
    const codexOverride = detectCodexExecutable(argumentValue(args, "--codex-exe"), environment);
    return {
      ok: true,
      agent: new CodexAgentClient(codexOverride === undefined ? {} : { codexPathOverride: codexOverride }),
    };
  }
  if (argumentValue(args, "--claude") !== undefined) {
    throw new ArgumentError("--claude cannot be combined with --backend llm; the LLM backend never launches a Claude Code executable.");
  }
  const credentialsPath = llmCredentialsPath(environment);
  const credentialsResult = await readLlmCredentials(credentialsPath);
  if (!credentialsResult.ok) return { ok: false, message: credentialsResult.message };
  try {
    return { ok: true, agent: new LlmAgentClient({ credentials: credentialsResult.value, credentialsPath }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
```
4. Run `bun test test/cli.test.ts`. Verify all new and updated cases pass, and the full pre-existing `--backend` suite still passes.

**Gate**: `bun test`, `bun run typecheck`, `bun run build` (`bin/shorthand-notes.ts` is the build entry point — run the build here as a check that surfaces, honestly, whether esbuild tries to inline `@openai/codex-sdk`'s own transitive deps before the `--external` flag is added in Task 10, rather than silently masking it).

**Commit**
```
feat(cli): add --backend codex to selectAgent

--codex-exe / SHORTHAND_CODEX_EXE resolve the executable through
detectCodexExecutable, mirroring the --claude / SHORTHAND_CLAUDE_EXE
precedent. --agent-stub still wins over --backend, unchanged.
```

---

## Task 10 — esbuild `--external:@openai/codex-sdk`

**Files**
- Modify: `package.json` (the `build` script)

**Steps**

There is no unit test for the build script; it is verified directly by running the build.

1. Run `bun run build` before the change (if not already attempted at the end of Task 9) and confirm it either fails or bundles `@openai/codex-sdk` inline — either way, this is the "failing" state this task fixes.
2. Modify `package.json`'s `build` script to add the external flag, keeping every existing one:
```json
"build": "esbuild bin/shorthand-notes.ts --bundle --platform=node --format=esm --target=node22 --external:@anthropic-ai/claude-agent-sdk --external:@openai/codex-sdk --external:googleapis --external:google-auth-library --external:ai --external:@ai-sdk/openai --external:@ai-sdk/anthropic --external:@ai-sdk/openai-compatible --outfile=dist/shorthand-notes.mjs",
```
3. Run `bun run build`. Verify it succeeds and `dist/shorthand-notes.mjs` does not bundle `@openai/codex-sdk`'s own dependency tree — confirm by checking the output size is close to its pre-Codex baseline rather than growing by the SDK's transitive install size:
```sh
bun run build && ls -la dist/shorthand-notes.mjs
```

**Gate**: `bun run build`, `bun test`, `bun run typecheck`.

**Commit**
```
chore(build): keep @openai/codex-sdk external to the CLI bundle

Matches every other provider SDK (@anthropic-ai/claude-agent-sdk, the
AI SDK packages): provider SDKs are never bundled, only referenced.
```

---

## Task 11 — `docs/DESIGN.md`: scope "no write tool" per backend

**Files**
- Modify: `docs/DESIGN.md` (the "Invariants — do not weaken these" section)

**Steps**

Documentation-only; no test exists or is warranted for prose content. Verified by review against the spec's "Capability gap" section.

1. Find and replace this paragraph:
```
**The agent has no write tool.** `options.tools` never contains `Write`/`Edit`/`Bash`, which
removes them from its context entirely. The only mutation path is our code. Vault reads are
confined to the vault by a `canUseTool` guard.
```
with:
```
**The agent has no write tool — on the Claude backend.** `options.tools` never contains
`Write`/`Edit`/`Bash`, which removes them from its context entirely. The only mutation path is
our code. Vault reads are confined to the vault by a `canUseTool` guard.

**The Codex backend cannot make the same guarantee.** `CodexAgentClient` wraps
`@openai/codex-sdk`, which always offers the model shell-exec and `apply_patch` — there is no
tool allowlist and no per-call approval hook to withhold them. `sandboxMode: "read-only"`
blocks an attempted write at the OS layer only *after* the model has already tried it. The
mitigation is `supportsVaultTools = false`: this backend never receives vault or note content
as filesystem context, so the read-only-but-attempted directory it can see is a scratch
directory this client owns and never contains anything sensitive for a write attempt to reach.
See `docs/superpowers/specs/2026-08-25-codex-agent-backend-design.md` for the full reasoning.
```
2. Read the diff back and confirm it no longer reads as an unconditional, codebase-wide guarantee.

**Gate**: `bun test`, `bun run typecheck` (sanity — a docs-only change should not affect either).

**Commit**
```
docs: scope "the agent has no write tool" per backend

Unconditional was true of ClaudeAgentClient alone. CodexAgentClient
cannot withhold shell-exec/apply_patch from the model at all — only
sandbox them after an attempt — so the invariant now says so, rather
than leaving the document actively wrong once the Codex backend ships.
```

---

## Task 12 — `README.md`: document `--backend codex`

**Files**
- Modify: `README.md` (Prerequisites; "Enhancement backends" section)

**Steps**

Documentation-only.

1. In the Prerequisites list (after the existing Claude-CLI bullet), add:
```
- For the `codex` backend, the `codex` CLI must be installed and logged in. There is no
  hardcoded install-path fallback (unlike the Claude backend's Windows default), so point
  `--codex-exe <path>` or `SHORTHAND_CODEX_EXE` at it if it is not on `PATH`.
```
2. Replace the "Enhancement backends" section's opening paragraph:
```
The CLI selects a backend with `--backend claude|llm`; omitting the flag selects `claude`.
The default backend resumes a Claude Agent SDK session and requires the `claude` CLI described
above. The `llm` backend instead uses the Vercel AI SDK to call OpenAI, Anthropic, Ollama, or
another OpenAI-compatible endpoint, and does not launch Claude Code.
```
with:
```
The CLI selects a backend with `--backend claude|llm|codex`; omitting the flag selects
`claude`. The default backend resumes a Claude Agent SDK session and requires the `claude` CLI
described above. The `llm` backend instead uses the Vercel AI SDK to call OpenAI, Anthropic,
Ollama, or another OpenAI-compatible endpoint, and does not launch Claude Code. The `codex`
backend wraps OpenAI's `@openai/codex-sdk` and, by default, reuses a locally logged-in `codex`
CLI session — no credentials file, no required API key (an `apiKey` constructor override
exists for the rarer case). It runs every pass in a scratch working directory this client
owns, with `sandboxMode: "read-only"`, `approvalPolicy: "never"`, and no tools ever forwarded
to the model in the allowlist sense — see "Invariants" in `docs/DESIGN.md` for the capability
gap this accepts.
```
3. Replace the "backends do not have identical lookup capabilities" paragraph:
```
The backends do not have identical lookup capabilities. Claude link-tier passes can use
`Read`/`Glob`/`Grep` inside the vault. The LLM backend has no tool loop, so every pass runs as
a tick pass, including the closing pass: its notes will not reference people, projects or
prior meetings discovered elsewhere in the vault.
```
with:
```
The backends do not have identical lookup capabilities. Claude link-tier passes can use
`Read`/`Glob`/`Grep` inside the vault. The LLM and Codex backends have no vault-confined tool
loop (`supportsVaultTools` is `false` for both), so every pass runs as a tick pass, including
the closing pass: its notes will not reference people, projects or prior meetings discovered
elsewhere in the vault.
```

**Gate**: `bun test`, `bun run typecheck` (sanity).

**Commit**
```
docs: document --backend codex in the README

Covers the --codex-exe/SHORTHAND_CODEX_EXE executable override, the
locally-logged-in-session auth posture, and the shared tick-tier
lookup-capability gap with the LLM backend.
```

---

## Task 13 — Final verification: all four gates green

**Files**: none (verification only).

**Steps**
1. Run, in order, stopping to fix and re-run on any failure before proceeding:
```sh
bun test
bun run typecheck
bun run build
bun run test:e2e
```
2. Confirm each exits 0. `bun run test:e2e` exercises the CLI end to end via `--agent-stub`, which is deliberately unaffected by this change (`ExecutableAgentStub` is backend-agnostic, per `selectAgent`'s stated precedence) — its continued pass is the evidence that wiring a third backend into `selectAgent()` did not disturb the stub precedence path.
3. Do not commit anything for this task — it is a verification checkpoint, not a code change. If any gate fails, the fix belongs to whichever earlier task's commit introduced the regression; amend that task's work with a new commit rather than papering over it here.

**Gate**: `bun test`, `bun run typecheck`, `bun run build`, `bun run test:e2e` — all four, all green.

---

### Critical Files for Implementation
- `src/agent/codex-client.ts`
- `test/codex-client.test.ts`
- `bin/shorthand-notes.ts`
- `src/index.ts`
- `package.json`
