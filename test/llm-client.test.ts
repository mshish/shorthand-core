import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_EDITORIAL_GUIDANCE,
  ENHANCEMENT_SAFETY_PREAMBLE,
  buildSectionOutputSchema,
  queryForSections,
  type AgentQueryRequest,
} from "../src/agent/contract.js";
import type { LlmCredentials } from "../src/agent/llm-credentials.js";

type CallOptions = Record<string, unknown>;
type ModelMessageLike = Readonly<{ role: string; content: unknown; providerOptions?: unknown }>;

/**
 * The real `ai` module is spread back in so `NoObjectGeneratedError` and
 * `NoOutputGeneratedError` stay the genuine classes: the client identifies them with their
 * own `isInstance` statics, and a hand-rolled stand-in would pass a test the real error
 * would fail. Only the three call-site seams are replaced.
 */
const actualAi = await import("ai");

const calls: CallOptions[] = [];
let respond: (options: CallOptions) => unknown = () => generatedResult({ sections: [] });

mock.module("ai", () => ({
  ...actualAi,
  generateText: async (options: CallOptions) => {
    calls.push(options);
    return await respond(options);
  },
  // Replaced so the test can see the exact JSON Schema handed to Output.object. With
  // `generateText` mocked the real implementations do no observable work anyway.
  jsonSchema: (schema: unknown) => ({ __jsonSchema: schema }),
  Output: { object: (specification: { schema: unknown }) => ({ __outputObject: specification }) },
}));

type ProviderCall = { factory: string; options: CallOptions; modelIds: string[] };
const providerCalls: ProviderCall[] = [];

function fakeProviderFactory(factory: string) {
  return (options: CallOptions = {}) => {
    const record: ProviderCall = { factory, options, modelIds: [] };
    providerCalls.push(record);
    return (modelId: string) => {
      record.modelIds.push(modelId);
      return { __model: `${factory}:${modelId}` };
    };
  };
}

// Provider selection, api-key/base-url propagation and the injected fetch all happen in the
// factories rather than in `ai`, so they are mocked separately or none of that is observable.
mock.module("@ai-sdk/openai", () => ({ createOpenAI: fakeProviderFactory("openai") }));
mock.module("@ai-sdk/anthropic", () => ({ createAnthropic: fakeProviderFactory("anthropic") }));
mock.module("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: fakeProviderFactory("openai-compatible") }));

const { LlmAgentClient } = await import("../src/agent/llm-client.js");

const SYSTEM_PROMPT = `${ENHANCEMENT_SAFETY_PREAMBLE}\n\n${DEFAULT_EDITORIAL_GUIDANCE}`;
const CACHE_HINT = { anthropic: { cacheControl: { type: "ephemeral" } } };
const API_KEY = "sk-planted-secret-key";

const warnLog: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  calls.length = 0;
  providerCalls.length = 0;
  warnLog.length = 0;
  respond = () => generatedResult({ sections: [{ heading: "Summary", markdown: "Done" }] });
  console.warn = (...args: unknown[]) => { warnLog.push(args.map(String).join(" ")); };
});

afterEach(() => { console.warn = realWarn; });

function credentials(overrides: Partial<LlmCredentials> = {}): LlmCredentials {
  return {
    provider: overrides.provider ?? "openai",
    model: overrides.model ?? "gpt-4o-mini",
    api_key: overrides.api_key ?? API_KEY,
    ...(overrides.base_url === undefined ? {} : { base_url: overrides.base_url }),
  };
}

type RequestOverrides = Readonly<{
  prompt?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  sessionId?: string;
  tools?: readonly string[];
  cwd?: string;
  maxTurns?: number;
  outputSchema?: Record<string, unknown>;
}>;

function agentRequest(overrides: RequestOverrides = {}): AgentQueryRequest {
  return {
    prompt: overrides.prompt ?? "Write the sections.",
    systemPrompt: overrides.systemPrompt ?? SYSTEM_PROMPT,
    tools: overrides.tools ?? [],
    settingSources: [],
    maxTurns: overrides.maxTurns ?? 4,
    outputSchema: overrides.outputSchema ?? buildSectionOutputSchema(),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
    ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
  };
}

/** Mirrors the real result: `output` is a getter, and a getter is free to throw. */
function generatedResult(output: unknown, warnings: readonly unknown[] = []) {
  return { warnings, get output() { return output; } };
}

function throwingResult(error: unknown, warnings: readonly unknown[] = []) {
  return { warnings, get output(): never { throw error; } };
}

function noObjectGenerated(message: string) {
  return new actualAi.NoObjectGeneratedError({
    message,
    text: "not json",
    response: { id: "r1", timestamp: new Date(0), modelId: "m" },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
    finishReason: "stop",
  });
}

function messagesOf(index = 0): readonly ModelMessageLike[] {
  return calls[index]!.messages as readonly ModelMessageLike[];
}

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, settle };
}

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("LlmAgentClient system prompt forwarding", () => {
  // The safety preamble is composed upstream and arrives as `systemPrompt`. The backend
  // inherits the injection guard ONLY if it forwards the string untouched, so exact equality
  // is the assertion; anything weaker would pass while the preamble was being reworded.
  const SYSTEM_PROMPT_CASES: Readonly<{ label: string; systemPrompt: string }>[] = [
    { label: "default composition", systemPrompt: SYSTEM_PROMPT },
    { label: "custom editorial half", systemPrompt: `${ENHANCEMENT_SAFETY_PREAMBLE}\n\nWrite like a court reporter.` },
    { label: "leading and trailing whitespace", systemPrompt: `\n  ${ENHANCEMENT_SAFETY_PREAMBLE}\n\n  ` },
    { label: "braces and template syntax", systemPrompt: `${ENHANCEMENT_SAFETY_PREAMBLE}\n\n{{not_a_placeholder}} \${also_not}` },
    { label: "non-ascii", systemPrompt: `${ENHANCEMENT_SAFETY_PREAMBLE}\n\nZachowaj zwiezlosc - 日本語も。` },
  ];

  test.each(SYSTEM_PROMPT_CASES)(
    "sends the system prompt verbatim as the leading message: $label",
    async ({ systemPrompt }) => {
      const client = new LlmAgentClient({ credentials: credentials() });
      await client.query(agentRequest({ systemPrompt }));
      const messages = messagesOf();
      expect(messages[0]!.role).toBe("system");
      expect(messages[0]!.content).toBe(systemPrompt);
      expect(messages[0]!.content).toContain(ENHANCEMENT_SAFETY_PREAMBLE);
    },
  );

  test("marks the system message for Anthropic ephemeral caching", async () => {
    const client = new LlmAgentClient({ credentials: credentials({ provider: "anthropic", model: "claude-sonnet-4-5" }) });
    await client.query(agentRequest());
    expect(messagesOf()[0]!.providerOptions).toEqual(CACHE_HINT);
  });
});

describe("LlmAgentClient request shape", () => {
  test("hands the request's JSON Schema to Output.object through jsonSchema", async () => {
    const outputSchema = buildSectionOutputSchema();
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest({ outputSchema }));
    expect(calls[0]!.output).toEqual({ __outputObject: { schema: { __jsonSchema: outputSchema } } });
  });

  test("sends the prompt as the trailing user message", async () => {
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest({ prompt: "Sections, please." }));
    expect(messagesOf()).toEqual([
      { role: "system", content: SYSTEM_PROMPT, providerOptions: CACHE_HINT },
      { role: "user", content: "Sections, please." },
    ]);
  });

  test("forwards no token ceiling and no turn budget", async () => {
    // D7: the providers derive maxOutputTokens from the model, and a second ceiling here
    // would drift from capabilities we do not control. maxTurns bounds a tool loop that
    // does not exist on this backend. Both absences are asserted so neither is "fixed".
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest({ maxTurns: 9 }));
    expect(calls[0]).not.toHaveProperty("maxOutputTokens");
    expect(calls[0]).not.toHaveProperty("maxTurns");
    expect(calls[0]).not.toHaveProperty("stopWhen");
  });

  test("ignores tools and cwd rather than promising them", async () => {
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest({ tools: ["Read", "Glob", "Grep"], cwd: "C:\\vault" }));
    for (const key of ["tools", "toolChoice", "activeTools", "prepareStep", "cwd"]) {
      expect(calls[0]).not.toHaveProperty(key);
    }
  });

  test("reports that it cannot use vault tools", () => {
    expect(new LlmAgentClient({ credentials: credentials() }).supportsVaultTools).toBe(false);
  });

  test("forwards the request signal and a configured per-request timeout", async () => {
    const controller = new AbortController();
    const client = new LlmAgentClient({ credentials: credentials(), timeoutMs: 30_000 });
    await client.query(agentRequest({ signal: controller.signal }));
    expect(calls[0]!.abortSignal).toBe(controller.signal);
    expect(calls[0]!.timeout).toBe(30_000);
  });

  test("omits the timeout when none is configured", async () => {
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest());
    expect(calls[0]).not.toHaveProperty("timeout");
  });
});

describe("LlmAgentClient provider construction", () => {
  test("builds an OpenAI provider with the key, the base url override and the injected fetch", () => {
    const injected = (async () => new Response()) as unknown as typeof globalThis.fetch;
    new LlmAgentClient({
      credentials: credentials({ provider: "openai", model: "gpt-4o", base_url: "https://gateway.example/v1" }),
      fetch: injected,
    });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.factory).toBe("openai");
    expect(providerCalls[0]!.options).toEqual({ apiKey: API_KEY, baseURL: "https://gateway.example/v1", fetch: injected });
    expect(providerCalls[0]!.modelIds).toEqual(["gpt-4o"]);
  });

  test("omits baseURL for OpenAI when the profile has none", () => {
    new LlmAgentClient({ credentials: credentials({ provider: "openai" }) });
    expect(providerCalls[0]!.options).not.toHaveProperty("baseURL");
  });

  test("honours base_url for Anthropic too, not only the compatible provider", () => {
    const injected = (async () => new Response()) as unknown as typeof globalThis.fetch;
    new LlmAgentClient({
      credentials: credentials({ provider: "anthropic", model: "claude-sonnet-4-5", base_url: "https://proxy.example" }),
      fetch: injected,
    });
    expect(providerCalls[0]!.factory).toBe("anthropic");
    expect(providerCalls[0]!.options).toEqual({ apiKey: API_KEY, baseURL: "https://proxy.example", fetch: injected });
    expect(providerCalls[0]!.modelIds).toEqual(["claude-sonnet-4-5"]);
  });

  test("builds an openai-compatible provider with its required base url", () => {
    const injected = (async () => new Response()) as unknown as typeof globalThis.fetch;
    new LlmAgentClient({
      credentials: { provider: "openai-compatible", model: "llama3.1", base_url: "http://127.0.0.1:11434/v1" },
      fetch: injected,
    });
    expect(providerCalls[0]!.factory).toBe("openai-compatible");
    expect(providerCalls[0]!.options).toEqual({
      name: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      fetch: injected,
    });
    expect(providerCalls[0]!.modelIds).toEqual(["llama3.1"]);
  });

  test("a keyless openai-compatible endpoint is allowed, because a local Ollama needs no key", () => {
    expect(() => new LlmAgentClient({
      credentials: { provider: "openai-compatible", model: "llama3.1", base_url: "http://127.0.0.1:11434/v1" },
    })).not.toThrow();
  });

  test("refuses an openai-compatible profile with no base url rather than posting to undefined", () => {
    // The reader rejects this profile, so reaching here means a caller hand-built the object.
    expect(() => new LlmAgentClient({ credentials: { provider: "openai-compatible", model: "llama3.1" } }))
      .toThrow(/base_url/);
  });

  test("rejects a keyless openai profile with a message that names the provider, the file and the fix", () => {
    let thrown: unknown;
    try {
      new LlmAgentClient({
        credentials: { provider: "openai", model: "gpt-4o" },
        credentialsPath: "C:\\Users\\x\\.shorthand\\llm-credentials.json",
      });
    } catch (error) { thrown = error; }
    const message = (thrown as Error).message;
    expect(message).toContain("openai");
    expect(message).toContain("C:\\Users\\x\\.shorthand\\llm-credentials.json");
    expect(message).toMatch(/settings/i);
    expect(message).toMatch(/switch to a provider/i);
  });

  test("rejects a keyless anthropic profile the same way", () => {
    expect(() => new LlmAgentClient({
      credentials: { provider: "anthropic", model: "claude-sonnet-4-5" },
      credentialsPath: "/home/x/.shorthand/llm-credentials.json",
    })).toThrow(/anthropic[\s\S]*\/home\/x\/\.shorthand\/llm-credentials\.json/);
  });

  test("names the default credentials path when no path was supplied", () => {
    let thrown: unknown;
    try { new LlmAgentClient({ credentials: { provider: "openai", model: "gpt-4o" } }); } catch (error) { thrown = error; }
    expect((thrown as Error).message).toContain("llm-credentials.json");
  });
});

describe("LlmAgentClient output handling", () => {
  test("passes the structured value through untouched, without judging the sections", async () => {
    // Two gates in two places is how one of them ends up subtly weaker: validateSectionOutput
    // is the only judge. An empty array is invalid there and must still arrive unchanged.
    const produced = { sections: [] };
    respond = () => generatedResult(produced);
    const client = new LlmAgentClient({ credentials: credentials() });
    const response = await client.query(agentRequest());
    expect(response.structuredOutput).toBe(produced);
  });

  test("returns a stable non-empty session id across passes", async () => {
    const client = new LlmAgentClient({ credentials: credentials() });
    const first = await client.query(agentRequest());
    const second = await client.query(agentRequest({ sessionId: first.sessionId }));
    expect(first.sessionId.length).toBeGreaterThan(0);
    expect(second.sessionId).toBe(first.sessionId);
  });

  test("two instances do not share a session id", async () => {
    const a = await new LlmAgentClient({ credentials: credentials() }).query(agentRequest());
    const b = await new LlmAgentClient({ credentials: credentials() }).query(agentRequest());
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("rejects a session id that belongs to a different client, which would splice two meetings together", async () => {
    const client = new LlmAgentClient({ credentials: credentials() });
    await expect(client.query(agentRequest({ sessionId: "some-other-capture" }))).rejects.toThrow(/session/i);
  });

  test("an empty session id is treated as absent rather than as a mismatch", async () => {
    const client = new LlmAgentClient({ credentials: credentials() });
    await expect(client.query(agentRequest({ sessionId: "" }))).resolves.toBeDefined();
  });

  test("refuses to start on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new LlmAgentClient({ credentials: credentials() });
    await expect(client.query(agentRequest({ signal: controller.signal }))).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(0);
  });
});

describe("LlmAgentClient error conversion", () => {
  test("converts NoObjectGeneratedError into an absent output with diagnostics", async () => {
    respond = () => { throw noObjectGenerated("schema validation failed"); };
    const client = new LlmAgentClient({ credentials: credentials() });
    const response = await client.query(agentRequest());
    expect(response.structuredOutput).toBeUndefined();
    expect(response.diagnostics?.join(" ")).toContain("schema validation failed");
  });

  test("converts NoOutputGeneratedError, which is what a length-truncated completion throws", async () => {
    // The `output` getter throws this when its backing value is null, which happens whenever
    // finishReason !== "stop". Letting it escape would cost the corrective second attempt for
    // exactly the truncation case D7 chose not to guard with maxOutputTokens.
    respond = () => throwingResult(new actualAi.NoOutputGeneratedError());
    const client = new LlmAgentClient({ credentials: credentials() });
    const response = await client.query(agentRequest());
    expect(response.structuredOutput).toBeUndefined();
    expect(response.diagnostics?.length).toBeGreaterThan(0);
  });

  test("the conversion buys the corrective second attempt through queryForSections", async () => {
    let attempt = 0;
    respond = () => {
      attempt += 1;
      if (attempt === 1) throw noObjectGenerated("sections was not an array");
      return generatedResult({ sections: [{ heading: "Summary", markdown: "Done" }] });
    };
    const client = new LlmAgentClient({ credentials: credentials() });
    const result = await queryForSections(client, agentRequest(), []);
    expect(result.status).toBe("valid");
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    const second = messagesOf(1).at(-1)!.content as string;
    expect(second).toContain("Your previous response was invalid.");
    expect(second).toContain("sections was not an array");
  });

  test("any other provider failure throws, naming the provider and the model", async () => {
    respond = () => { throw new Error("429 rate limit exceeded"); };
    const client = new LlmAgentClient({ credentials: credentials({ provider: "openai", model: "gpt-4o" }) });
    let thrown: unknown;
    try { await client.query(agentRequest()); } catch (error) { thrown = error; }
    const message = (thrown as Error).message;
    expect(message).toContain("openai");
    expect(message).toContain("gpt-4o");
    expect(message).toContain("429 rate limit exceeded");
  });

  test("scrubs the configured key out of a thrown provider error", async () => {
    // Providers echo the Authorization header back in some 401 bodies, and this message ends
    // up in an operator log and in the note's status line.
    respond = () => { throw new Error(`401 Unauthorized: key ${API_KEY} is revoked`); };
    const client = new LlmAgentClient({ credentials: credentials() });
    let thrown: unknown;
    try { await client.query(agentRequest()); } catch (error) { thrown = error; }
    const message = (thrown as Error).message;
    expect(message).not.toContain(API_KEY);
    expect(message).toContain("[REDACTED]");
  });

  test("scrubs the configured key out of the diagnostics path too", async () => {
    respond = () => { throw noObjectGenerated(`upstream rejected key ${API_KEY} mid-stream`); };
    const client = new LlmAgentClient({ credentials: credentials() });
    const response = await client.query(agentRequest());
    const diagnostics = response.diagnostics?.join(" ") ?? "";
    expect(diagnostics).not.toContain(API_KEY);
    expect(diagnostics).toContain("[REDACTED]");
  });

  test("an abort during the call surfaces as a thrown error, not as absent output", async () => {
    const controller = new AbortController();
    respond = () => { controller.abort(); throw new Error("This operation was aborted"); };
    const client = new LlmAgentClient({ credentials: credentials() });
    await expect(client.query(agentRequest({ signal: controller.signal }))).rejects.toThrow();
  });
});

describe("LlmAgentClient provider warnings", () => {
  const warning = { type: "other" as const, message: "unknown model id; clamping max tokens to 4096" };

  test("surfaces provider warnings in diagnostics", async () => {
    respond = () => generatedResult({ sections: [] }, [warning]);
    const client = new LlmAgentClient({ credentials: credentials() });
    const response = await client.query(agentRequest());
    expect(response.diagnostics?.join(" ")).toContain("clamping max tokens to 4096");
  });

  test("also warns on the console, because diagnostics are inert on a successful pass", async () => {
    respond = () => generatedResult({ sections: [] }, [warning]);
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest());
    expect(warnLog.join(" ")).toContain("clamping max tokens to 4096");
  });

  test("repeats a given warning once per instance, not once per pass", async () => {
    // A four-hour capture makes dozens of passes; an undeduped warning would bury the log.
    respond = () => generatedResult({ sections: [] }, [warning]);
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest());
    await client.query(agentRequest());
    await client.query(agentRequest());
    expect(warnLog).toHaveLength(1);
  });

  test("a distinct warning still gets its own line", async () => {
    const other = { type: "unsupported" as const, feature: "toolChoice" };
    respond = () => generatedResult({ sections: [] }, [warning]);
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest());
    respond = () => generatedResult({ sections: [] }, [warning, other]);
    await client.query(agentRequest());
    expect(warnLog).toHaveLength(2);
    expect(warnLog[1]).toContain("toolChoice");
  });

  test("scrubs the key out of a warning before logging it", async () => {
    respond = () => generatedResult({ sections: [] }, [{ type: "other" as const, message: `header carried ${API_KEY}` }]);
    const client = new LlmAgentClient({ credentials: credentials() });
    const response = await client.query(agentRequest());
    expect(warnLog.join(" ")).not.toContain(API_KEY);
    expect(response.diagnostics?.join(" ")).not.toContain(API_KEY);
  });
});

describe("LlmAgentClient history", () => {
  test("a second pass carries the first pass's user and assistant turns", async () => {
    const produced = { sections: [{ heading: "Summary", markdown: "Done" }] };
    respond = () => generatedResult(produced);
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest({ prompt: "first" }));
    await client.query(agentRequest({ prompt: "second" }));
    const messages = messagesOf(1);
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1]!.content).toBe("first");
    expect(messages[2]!.content).toBe(JSON.stringify(produced));
    expect(messages[3]!.content).toBe("second");
  });

  test("a pass whose output parsed to undefined appends nothing rather than a non-string turn", async () => {
    respond = () => generatedResult(undefined);
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest({ prompt: "first" }));
    respond = () => generatedResult({ sections: [] });
    await client.query(agentRequest({ prompt: "second" }));
    expect(messagesOf(1).map((message) => message.role)).toEqual(["system", "user"]);
  });

  test("a pass that produced no structured output leaves no half pair behind", async () => {
    respond = () => { throw noObjectGenerated("nope"); };
    const client = new LlmAgentClient({ credentials: credentials() });
    await client.query(agentRequest({ prompt: "first" }));
    respond = () => generatedResult({ sections: [] });
    await client.query(agentRequest({ prompt: "second" }));
    expect(messagesOf(1).map((message) => message.role)).toEqual(["system", "user"]);
  });
});

describe("LlmAgentClient history commit rule", () => {
  test("an aborted pass that resolves after its replacement appended does not win the race", async () => {
    // The exact window runner.ts leaves open: a timeout aborts, requeues and keeps tracking
    // the abandoned promise, so pass A can settle after pass B has already committed.
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const queue = [a.promise, b.promise];
    respond = () => queue.shift()!;
    const client = new LlmAgentClient({ credentials: credentials() });

    const controller = new AbortController();
    const passA = client.query(agentRequest({ prompt: "A", signal: controller.signal }));
    await tick();
    controller.abort();
    const passB = client.query(agentRequest({ prompt: "B" }));
    await tick();
    b.settle(generatedResult({ sections: [{ heading: "B", markdown: "b" }] }));
    await passB;
    a.settle(generatedResult({ sections: [{ heading: "A", markdown: "a" }] }));
    await passA.catch(() => {});

    respond = () => generatedResult({ sections: [] });
    await client.query(agentRequest({ prompt: "C" }));
    expect(messagesOf(2).map((message) => message.content)).toEqual([
      SYSTEM_PROMPT,
      "B",
      JSON.stringify({ sections: [{ heading: "B", markdown: "b" }] }),
      "C",
    ]);
  });

  test("a stale pass loses even when nothing aborted it, so the generation check is load-bearing", async () => {
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const queue = [a.promise, b.promise];
    respond = () => queue.shift()!;
    const client = new LlmAgentClient({ credentials: credentials() });

    const passA = client.query(agentRequest({ prompt: "A" }));
    await tick();
    const passB = client.query(agentRequest({ prompt: "B" }));
    await tick();
    b.settle(generatedResult({ sections: [{ heading: "B", markdown: "b" }] }));
    await passB;
    a.settle(generatedResult({ sections: [{ heading: "A", markdown: "a" }] }));
    await passA;

    respond = () => generatedResult({ sections: [] });
    await client.query(agentRequest({ prompt: "C" }));
    expect(messagesOf(2).map((message) => message.content)).toEqual([
      SYSTEM_PROMPT,
      "B",
      JSON.stringify({ sections: [{ heading: "B", markdown: "b" }] }),
      "C",
    ]);
  });

  test("an aborted pass loses even when no replacement ever ran, so the abort check is load-bearing", async () => {
    const a = deferred<unknown>();
    respond = () => a.promise;
    const client = new LlmAgentClient({ credentials: credentials() });
    const controller = new AbortController();
    const passA = client.query(agentRequest({ prompt: "A", signal: controller.signal }));
    await tick();
    controller.abort();
    a.settle(generatedResult({ sections: [{ heading: "A", markdown: "a" }] }));
    await passA.catch(() => {});

    respond = () => generatedResult({ sections: [] });
    await client.query(agentRequest({ prompt: "C" }));
    expect(messagesOf(1).map((message) => message.role)).toEqual(["system", "user"]);
  });
});

describe("LlmAgentClient history budget", () => {
  test("drops whole oldest pairs until the retained history fits, never a half pair", async () => {
    // Sized so that evicting the oldest USER message alone would already fit the budget:
    // an implementation that dropped one message at a time would stop there and leave a
    // leading assistant turn, which reads to the model as a reply to nothing. Only pair
    // eviction produces the roles asserted below.
    const answer = { sections: [{ heading: "H", markdown: "x".repeat(10) }] };
    respond = () => generatedResult(answer);
    const client = new LlmAgentClient({ credentials: credentials(), maxHistoryCharacters: 1000 });
    await client.query(agentRequest({ prompt: "p".repeat(800) }));
    await client.query(agentRequest({ prompt: "q".repeat(800) }));
    await client.query(agentRequest({ prompt: "final" }));
    const messages = messagesOf(2);
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1]!.content).toBe("q".repeat(800));
    expect(messages[2]!.content).toBe(JSON.stringify(answer));
  });

  test("keeps a pair that fits, so the budget does not evict eagerly", async () => {
    respond = () => generatedResult({ sections: [{ heading: "H", markdown: "x".repeat(10) }] });
    const client = new LlmAgentClient({ credentials: credentials(), maxHistoryCharacters: 1000 });
    await client.query(agentRequest({ prompt: "p".repeat(800) }));
    await client.query(agentRequest({ prompt: "q".repeat(800) }));
    expect(messagesOf(1).map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  test("the system message and the current prompt are outside the budget and never evictable", async () => {
    // A budget that could evict the system message would silently drop the safety preamble.
    const client = new LlmAgentClient({ credentials: credentials(), maxHistoryCharacters: 0 });
    await client.query(agentRequest({ prompt: "first" }));
    await client.query(agentRequest({ prompt: "second" }));
    const messages = messagesOf(1);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe(SYSTEM_PROMPT);
    expect(messages[1]!.content).toBe("second");
  });

  test("a budget smaller than the system prompt still leaves a working call", async () => {
    const client = new LlmAgentClient({ credentials: credentials(), maxHistoryCharacters: 10 });
    await client.query(agentRequest({ prompt: "first" }));
    const response = await client.query(agentRequest({ prompt: "second" }));
    expect(response.structuredOutput).toBeDefined();
    expect(messagesOf(1)[0]!.content).toBe(SYSTEM_PROMPT);
  });

  const BAD_BUDGETS: Readonly<{ label: string; value: number }>[] = [
    { label: "negative", value: -1 },
    { label: "fractional", value: 1.5 },
    { label: "NaN", value: Number.NaN },
    { label: "infinite", value: Number.POSITIVE_INFINITY },
  ];

  test.each(BAD_BUDGETS)("rejects a $label history budget at construction, not at first use", ({ value }) => {
    expect(() => new LlmAgentClient({ credentials: credentials(), maxHistoryCharacters: value }))
      .toThrow(/maxHistoryCharacters/);
  });
});
