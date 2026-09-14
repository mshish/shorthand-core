import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_EDITORIAL_GUIDANCE,
  ENHANCEMENT_SAFETY_PREAMBLE,
  buildSectionOutputSchema,
  queryForSections,
  type AgentQueryRequest,
} from "../src/agent/contract.js";
import type { LlmProfile } from "../src/agent/llm-credentials.js";

type CallOptions = Record<string, unknown>;
type ModelMessageLike = Readonly<{ role: string; content: unknown; providerOptions?: unknown }>;

/**
 * The real `ai` module is spread back in so `NoObjectGeneratedError` and
 * `NoOutputGeneratedError` stay the genuine classes: the client identifies them with their
 * own `isInstance` statics, and a hand-rolled stand-in would pass a test the real error
 * would fail. Only the three call-site seams are replaced.
 */
const actualAi = await import("ai");
// Captured BEFORE mock.module, and this is not defensive style — bun's mock.module mutates
// the live module namespace in place, so after registration `actualAi.jsonSchema` resolves
// to the mock below. Reading it through the namespace inside the wrapper recurses until the
// process runs out of memory (observed: 2GB RSS, then a Bun panic).
const realGenerateText = actualAi.generateText;
const realJsonSchema = actualAi.jsonSchema;
const realOutputObject = actualAi.Output.object;
const { NoObjectGeneratedError, NoOutputGeneratedError } = actualAi;

const calls: CallOptions[] = [];
const schemasSeen: unknown[] = [];
const outputSpecsSeen: { schema: unknown }[] = [];
let respond: (options: CallOptions) => unknown = () => generatedResult({ sections: [] });

mock.module("ai", () => ({
  ...actualAi,
  generateText: async (options: CallOptions) => {
    calls.push(options);
    return await respond(options);
  },
  // WRAPPED, not replaced. Recording the arguments keeps them observable, and returning the
  // real values keeps every entry in `calls` a set of options the real `generateText` can
  // actually consume — which is what lets one test replay the client's own call against the
  // SDK's validation path instead of only against this mock.
  jsonSchema: (schema: unknown) => {
    schemasSeen.push(schema);
    return realJsonSchema(schema as Parameters<typeof realJsonSchema>[0]);
  },
  Output: {
    object: (specification: { schema: unknown }) => {
      outputSpecsSeen.push(specification);
      return realOutputObject(specification as Parameters<typeof realOutputObject>[0]);
    },
  },
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

// Provider selection, the placeholder key and the injected fetch all happen in the factories
// rather than in `ai`, so they are mocked separately or none of that is observable.
mock.module("@ai-sdk/openai", () => ({ createOpenAI: fakeProviderFactory("openai") }));
mock.module("@ai-sdk/anthropic", () => ({ createAnthropic: fakeProviderFactory("anthropic") }));
mock.module("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: fakeProviderFactory("openai-compatible") }));
mock.module("ai-sdk-ollama", () => ({ createOllama: fakeProviderFactory("ollama") }));

const { APP_MANAGED_API_KEY, LlmAgentClient, llmEndpointOrigin } = await import("../src/agent/llm-client.js");

const SYSTEM_PROMPT = `${ENHANCEMENT_SAFETY_PREAMBLE}\n\n${DEFAULT_EDITORIAL_GUIDANCE}`;
const CACHE_HINT = { anthropic: { cacheControl: { type: "ephemeral" } } };
/**
 * Stands in for `createAppFetch`'s result: every request this client makes goes through the
 * Shorthand app, and the client has no other way to reach a provider.
 */
const FETCH = (async () => new Response()) as unknown as typeof globalThis.fetch;

const warnLog: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  calls.length = 0;
  schemasSeen.length = 0;
  outputSpecsSeen.length = 0;
  providerCalls.length = 0;
  warnLog.length = 0;
  respond = () => generatedResult({ sections: [{ heading: "Summary", markdown: "Done" }] });
  console.warn = (...args: unknown[]) => { warnLog.push(args.map(String).join(" ")); };
});

afterEach(() => { console.warn = realWarn; });

function profile(overrides: Partial<LlmProfile> = {}): LlmProfile {
  return {
    provider: overrides.provider ?? "openai",
    model: overrides.model ?? "gpt-4o-mini",
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
  return new NoObjectGeneratedError({
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

/**
 * The system prompt travels as `generateText`'s `instructions` option, never as an element
 * of `messages` — `standardizePrompt` rejects a system role there outright.
 */
function instructionsOf(index = 0): ModelMessageLike {
  return calls[index]!.instructions as ModelMessageLike;
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
      const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
      await client.query(agentRequest({ systemPrompt }));
      expect(instructionsOf().role).toBe("system");
      expect(instructionsOf().content).toBe(systemPrompt);
      expect(instructionsOf().content).toContain(ENHANCEMENT_SAFETY_PREAMBLE);
      // And never as a message: standardizePrompt throws InvalidPromptError on a system role
      // inside `messages`, before the provider is reached.
      expect(messagesOf().some((message) => message.role === "system")).toBe(false);
    },
  );

  test("marks the system message for Anthropic ephemeral caching", async () => {
    const client = new LlmAgentClient({ profile: profile({ provider: "anthropic", model: "claude-sonnet-4-5" }), fetch: FETCH });
    await client.query(agentRequest());
    expect(instructionsOf().providerOptions).toEqual(CACHE_HINT);
  });
});

describe("LlmAgentClient request shape", () => {
  test("hands the request's JSON Schema to Output.object through jsonSchema", async () => {
    const outputSchema = buildSectionOutputSchema();
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest({ outputSchema }));
    expect(schemasSeen).toEqual([outputSchema]);
    // The schema object Output.object received carries our exact JSON Schema, by identity.
    expect((outputSpecsSeen[0]!.schema as { jsonSchema: unknown }).jsonSchema).toBe(outputSchema);
  });

  test("sends the prompt as the trailing user message", async () => {
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest({ prompt: "Sections, please." }));
    expect(messagesOf()).toEqual([{ role: "user", content: "Sections, please." }]);
    expect(instructionsOf()).toEqual({ role: "system", content: SYSTEM_PROMPT, providerOptions: CACHE_HINT });
  });

  test("forwards no token ceiling and no turn budget", async () => {
    // D7: the providers derive maxOutputTokens from the model, and a second ceiling here
    // would drift from capabilities we do not control. maxTurns bounds a tool loop that
    // does not exist on this backend. Both absences are asserted so neither is "fixed".
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest({ maxTurns: 9 }));
    expect(calls[0]).not.toHaveProperty("maxOutputTokens");
    expect(calls[0]).not.toHaveProperty("maxTurns");
    expect(calls[0]).not.toHaveProperty("stopWhen");
  });

  test("ignores tools and cwd rather than promising them", async () => {
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest({ tools: ["Read", "Glob", "Grep"], cwd: "C:\\vault" }));
    for (const key of ["tools", "toolChoice", "activeTools", "prepareStep", "cwd"]) {
      expect(calls[0]).not.toHaveProperty(key);
    }
  });

  test("reports that it cannot use vault tools", () => {
    expect(new LlmAgentClient({ profile: profile(), fetch: FETCH }).supportsVaultTools).toBe(false);
  });

  test("forwards the request signal and a configured per-request timeout", async () => {
    const controller = new AbortController();
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH, timeoutMs: 30_000 });
    await client.query(agentRequest({ signal: controller.signal }));
    expect(calls[0]!.abortSignal).toBe(controller.signal);
    expect(calls[0]!.timeout).toBe(30_000);
  });

  test("omits the timeout when none is configured", async () => {
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest());
    expect(calls[0]).not.toHaveProperty("timeout");
  });
});

describe("LlmAgentClient provider construction", () => {
  test("builds an OpenAI provider with the placeholder key, the base url override and the app fetch", () => {
    const injected = (async () => new Response()) as unknown as typeof globalThis.fetch;
    new LlmAgentClient({
      profile: profile({ provider: "openai", model: "gpt-4o", base_url: "https://gateway.example/v1" }),
      fetch: injected,
    });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.factory).toBe("openai");
    // The factory demands a key string and this process has none: the app strips whatever
    // authorization header the SDK builds from this one and injects the real secret.
    expect(providerCalls[0]!.options).toEqual({
      apiKey: "managed-by-shorthand",
      baseURL: "https://gateway.example/v1",
      fetch: injected,
    });
    expect(providerCalls[0]!.modelIds).toEqual(["gpt-4o"]);
  });

  test("exports the placeholder key it hands the factories", () => {
    expect(APP_MANAGED_API_KEY).toBe("managed-by-shorthand");
  });

  test("omits baseURL for OpenAI when the profile has none", () => {
    new LlmAgentClient({ profile: profile({ provider: "openai" }), fetch: FETCH });
    expect(providerCalls[0]!.options).not.toHaveProperty("baseURL");
  });

  test("honours base_url for Anthropic too, not only the compatible provider", () => {
    const injected = (async () => new Response()) as unknown as typeof globalThis.fetch;
    new LlmAgentClient({
      profile: profile({ provider: "anthropic", model: "claude-sonnet-4-5", base_url: "https://proxy.example" }),
      fetch: injected,
    });
    expect(providerCalls[0]!.factory).toBe("anthropic");
    expect(providerCalls[0]!.options).toEqual({
      apiKey: "managed-by-shorthand",
      baseURL: "https://proxy.example",
      fetch: injected,
    });
    expect(providerCalls[0]!.modelIds).toEqual(["claude-sonnet-4-5"]);
  });

  test("builds an openai-compatible provider with its required base url", () => {
    const injected = (async () => new Response()) as unknown as typeof globalThis.fetch;
    new LlmAgentClient({
      profile: { provider: "openai-compatible", model: "llama3.1", base_url: "http://127.0.0.1:11434/v1" },
      fetch: injected,
    });
    expect(providerCalls[0]!.factory).toBe("openai-compatible");
    // No apiKey at all: this provider sends one only when given one, and the app supplies the
    // header when the slot has a secret. A local endpoint authenticates nothing.
    expect(providerCalls[0]!.options).toEqual({
      name: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      supportsStructuredOutputs: true,
      fetch: injected,
    });
    expect(providerCalls[0]!.modelIds).toEqual(["llama3.1"]);
  });

  test("openai-compatible is told it supports structured outputs, or the schema is dropped", () => {
    // Pinned separately from the construction test above because the consequence is invisible
    // at construction time: the provider defaults this to false and then silently downgrades
    // `response_format` to `{"type":"json_object"}`, discarding the section schema. Every pass
    // against a local endpoint then fails to parse and exhausts the retry ladder. Deleting the
    // flag would leave the assertion above passing, so it needs a test that names the reason.
    new LlmAgentClient({
      profile: { provider: "openai-compatible", model: "llama3.1", base_url: "http://127.0.0.1:1234/v1" },
      fetch: FETCH,
    });
    expect(providerCalls[0]!.options).toMatchObject({ supportsStructuredOutputs: true });
  });

  test("builds an ollama provider defaulting to http://127.0.0.1:11434", () => {
    const injected = (async () => new Response()) as unknown as typeof globalThis.fetch;
    new LlmAgentClient({ profile: { provider: "ollama", model: "llama3.2" }, fetch: injected });
    expect(providerCalls[0]!.factory).toBe("ollama");
    expect(providerCalls[0]!.options).toEqual({
      baseURL: "http://127.0.0.1:11434",
      fetch: injected,
    });
    expect(providerCalls[0]!.modelIds).toEqual(["llama3.2"]);
  });

  test("builds an ollama provider with a custom base_url when one is given", () => {
    new LlmAgentClient({
      profile: { provider: "ollama", model: "deepseek-r1:8b", base_url: "http://192.168.1.100:11434" },
      fetch: FETCH,
    });
    expect(providerCalls[0]!.factory).toBe("ollama");
    expect(providerCalls[0]!.options).toEqual({
      baseURL: "http://192.168.1.100:11434",
      fetch: FETCH,
    });
    expect(providerCalls[0]!.modelIds).toEqual(["deepseek-r1:8b"]);
  });

  test("every provider is built on the injected fetch, since nothing else can reach the network", () => {
    // The app performs the request and holds the key. A factory built without this fetch
    // would call the provider directly from this process, unauthenticated.
    const cases: readonly LlmProfile[] = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude-sonnet-4-5" },
      { provider: "openai-compatible", model: "llama3.1", base_url: "http://127.0.0.1:11434/v1" },
      { provider: "ollama", model: "llama3.2" },
    ];
    for (const each of cases) new LlmAgentClient({ profile: each, fetch: FETCH });
    expect(providerCalls.map((call) => call.factory))
      .toEqual(["openai", "anthropic", "openai-compatible", "ollama"]);
    for (const call of providerCalls) expect(call.options.fetch).toBe(FETCH);
  });

  test("refuses an openai-compatible profile with no base url rather than posting to undefined", () => {
    // A caller hand-built this profile: both the CLI and the plugin require a base url for
    // this provider, because the endpoint is unknowable without one.
    expect(() => new LlmAgentClient({ profile: { provider: "openai-compatible", model: "llama3.1" }, fetch: FETCH }))
      .toThrow(/base_url/);
  });
});

describe("llmEndpointOrigin", () => {
  // This is what the caller puts in the credential slot, and the app refuses any request whose
  // URL origin differs from it. A path or a trailing slash here is an origin_mismatch on every
  // call, so each case pins the exact string.
  const CASES: Readonly<{ label: string; profile: LlmProfile; origin: string }>[] = [
    { label: "openai default", profile: { provider: "openai", model: "gpt-4o" }, origin: "https://api.openai.com" },
    {
      label: "openai with the api base url spelled out",
      profile: { provider: "openai", model: "gpt-4o", base_url: "https://api.openai.com/v1" },
      origin: "https://api.openai.com",
    },
    {
      // The app derives the slot the same way, so a `:443` that survived here would be a
      // mismatch against an origin the app collapsed.
      label: "openai with the default https port spelled out",
      profile: { provider: "openai", model: "gpt-4o", base_url: "https://api.openai.com:443/v1" },
      origin: "https://api.openai.com",
    },
    {
      label: "openai behind a gateway on a port",
      profile: { provider: "openai", model: "gpt-4o", base_url: "https://Gateway.Example:8443/openai/v1" },
      origin: "https://gateway.example:8443",
    },
    {
      label: "anthropic default",
      profile: { provider: "anthropic", model: "claude-sonnet-4-5" },
      origin: "https://api.anthropic.com",
    },
    {
      label: "anthropic behind a proxy",
      profile: { provider: "anthropic", model: "claude-sonnet-4-5", base_url: "https://proxy.example/anthropic" },
      origin: "https://proxy.example",
    },
    { label: "ollama default", profile: { provider: "ollama", model: "llama3.2" }, origin: "http://127.0.0.1:11434" },
    {
      label: "ollama on another host",
      profile: { provider: "ollama", model: "llama3.2", base_url: "http://192.168.1.100:11434" },
      origin: "http://192.168.1.100:11434",
    },
    {
      label: "openai-compatible from its base url",
      profile: { provider: "openai-compatible", model: "llama3.1", base_url: "http://127.0.0.1:1234/v1" },
      origin: "http://127.0.0.1:1234",
    },
    {
      label: "openai-compatible from a base url that is only a trailing slash",
      profile: { provider: "openai-compatible", model: "llama3.1", base_url: "http://127.0.0.1:1234/" },
      origin: "http://127.0.0.1:1234",
    },
  ];

  test.each(CASES)("returns $origin for $label", ({ profile: each, origin }) => {
    expect(llmEndpointOrigin(each)).toBe(origin);
  });

  test("matches the ollama default the client actually builds", () => {
    // Two constants naming the same endpoint is exactly the pair that drifts, and drift here
    // is silent until the app rejects every call as an origin mismatch.
    new LlmAgentClient({ profile: { provider: "ollama", model: "llama3.2" }, fetch: FETCH });
    expect(providerCalls[0]!.options.baseURL).toBe(llmEndpointOrigin({ provider: "ollama", model: "llama3.2" }));
  });

  test("refuses an openai-compatible profile with no base url, since it names no endpoint", () => {
    expect(() => llmEndpointOrigin({ provider: "openai-compatible", model: "llama3.1" })).toThrow(/base_url/);
  });

  test("refuses a base url that is not an absolute URL, naming the value", () => {
    expect(() => llmEndpointOrigin({ provider: "openai", model: "gpt-4o", base_url: "api.openai.com/v1" }))
      .toThrow(/api\.openai\.com\/v1/);
  });

  test.each([
    // `new URL("file:///x").origin` is the literal "null", which would otherwise reach the app
    // as a slot origin and fail there instead of here.
    ["file:///models", "file:"],
    // These two DO have an origin, so a null-origin check would let them through. The app only
    // performs `http.fetch`, so a slot registered under either authorises a request that can
    // never be made.
    ["ws://127.0.0.1:1234", "ws:"],
    ["ftp://models.example/v1", "ftp:"],
  ])("refuses the base url %s, naming the scheme", (baseUrl, scheme) => {
    expect(() => llmEndpointOrigin({ provider: "openai-compatible", model: "m", base_url: baseUrl }))
      .toThrow(`base_url ${JSON.stringify(baseUrl)} uses scheme ${JSON.stringify(scheme)}; use an http or https URL.`);
  });
});

describe("LlmAgentClient output handling", () => {
  test("passes the structured value through untouched, without judging the sections", async () => {
    // Two gates in two places is how one of them ends up subtly weaker: validateSectionOutput
    // is the only judge. An empty array is invalid there and must still arrive unchanged.
    const produced = { sections: [] };
    respond = () => generatedResult(produced);
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    const response = await client.query(agentRequest());
    expect(response.structuredOutput).toBe(produced);
  });

  test("returns a stable non-empty session id across passes", async () => {
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    const first = await client.query(agentRequest());
    const second = await client.query(agentRequest({ sessionId: first.sessionId }));
    expect(first.sessionId.length).toBeGreaterThan(0);
    expect(second.sessionId).toBe(first.sessionId);
  });

  test("two instances do not share a session id", async () => {
    const a = await new LlmAgentClient({ profile: profile(), fetch: FETCH }).query(agentRequest());
    const b = await new LlmAgentClient({ profile: profile(), fetch: FETCH }).query(agentRequest());
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("rejects a session id that belongs to a different client, which would splice two meetings together", async () => {
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await expect(client.query(agentRequest({ sessionId: "some-other-capture" }))).rejects.toThrow(/session/i);
  });

  test("an empty session id is treated as absent rather than as a mismatch", async () => {
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await expect(client.query(agentRequest({ sessionId: "" }))).resolves.toBeDefined();
  });

  test("refuses to start on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await expect(client.query(agentRequest({ signal: controller.signal }))).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(0);
  });
});

describe("LlmAgentClient error conversion", () => {
  test("converts NoObjectGeneratedError into an absent output with diagnostics", async () => {
    respond = () => { throw noObjectGenerated("schema validation failed"); };
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    const response = await client.query(agentRequest());
    expect(response.structuredOutput).toBeUndefined();
    expect(response.diagnostics?.join(" ")).toContain("schema validation failed");
  });

  test("converts NoOutputGeneratedError, which is what a length-truncated completion throws", async () => {
    // The `output` getter throws this when its backing value is null, which happens whenever
    // finishReason !== "stop". Letting it escape would cost the corrective second attempt for
    // exactly the truncation case D7 chose not to guard with maxOutputTokens.
    respond = () => throwingResult(new NoOutputGeneratedError());
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
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
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
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
    const client = new LlmAgentClient({ profile: profile({ provider: "openai", model: "gpt-4o" }), fetch: FETCH });
    let thrown: unknown;
    try { await client.query(agentRequest()); } catch (error) { thrown = error; }
    const message = (thrown as Error).message;
    expect(message).toContain("openai");
    expect(message).toContain("gpt-4o");
    expect(message).toContain("429 rate limit exceeded");
  });

  test("reports a provider message verbatim, because this process holds no key to scrub", async () => {
    // The client used to rewrite every message it produced, to hide the key it held. It holds
    // none now — the app injects the secret — so a 401 body arrives intact, and an operator
    // reading the note's status line sees what the provider actually said.
    respond = () => { throw new Error("401 Unauthorized: the key for this request is revoked"); };
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    let thrown: unknown;
    try { await client.query(agentRequest()); } catch (error) { thrown = error; }
    const message = (thrown as Error).message;
    expect(message).toContain("401 Unauthorized: the key for this request is revoked");
    expect(message).not.toContain("[REDACTED]");
  });

  test("reports a diagnostic verbatim too", async () => {
    respond = () => { throw noObjectGenerated("model   returned   nothing   usable"); };
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    const response = await client.query(agentRequest());
    expect(response.diagnostics?.join(" ")).toContain("model   returned   nothing   usable");
    expect(response.diagnostics?.join(" ")).not.toContain("[REDACTED]");
  });

  test("an abort during the call surfaces as a thrown error, not as absent output", async () => {
    const controller = new AbortController();
    respond = () => { controller.abort(); throw new Error("This operation was aborted"); };
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await expect(client.query(agentRequest({ signal: controller.signal }))).rejects.toThrow();
  });
});

describe("LlmAgentClient provider warnings", () => {
  const warning = { type: "other" as const, message: "unknown model id; clamping max tokens to 4096" };

  test("surfaces provider warnings in diagnostics", async () => {
    respond = () => generatedResult({ sections: [] }, [warning]);
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    const response = await client.query(agentRequest());
    expect(response.diagnostics?.join(" ")).toContain("clamping max tokens to 4096");
  });

  test("also warns on the console, because diagnostics are inert on a successful pass", async () => {
    respond = () => generatedResult({ sections: [] }, [warning]);
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest());
    expect(warnLog.join(" ")).toContain("clamping max tokens to 4096");
  });

  test("repeats a given warning once per instance, not once per pass", async () => {
    // A four-hour capture makes dozens of passes; an undeduped warning would bury the log.
    respond = () => generatedResult({ sections: [] }, [warning]);
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest());
    await client.query(agentRequest());
    await client.query(agentRequest());
    expect(warnLog).toHaveLength(1);
  });

  test("a distinct warning still gets its own line", async () => {
    const other = { type: "unsupported" as const, feature: "toolChoice" };
    respond = () => generatedResult({ sections: [] }, [warning]);
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest());
    respond = () => generatedResult({ sections: [] }, [warning, other]);
    await client.query(agentRequest());
    expect(warnLog).toHaveLength(2);
    expect(warnLog[1]).toContain("toolChoice");
  });

  test("logs a warning verbatim, on both outlets", async () => {
    respond = () => generatedResult({ sections: [] }, [{ type: "other" as const, message: "header x-foo was ignored" }]);
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    const response = await client.query(agentRequest());
    expect(warnLog.join(" ")).toContain("header x-foo was ignored");
    expect(response.diagnostics?.join(" ")).toContain("header x-foo was ignored");
  });
});

describe("LlmAgentClient history", () => {
  test("a second pass carries the first pass's user and assistant turns", async () => {
    const produced = { sections: [{ heading: "Summary", markdown: "Done" }] };
    respond = () => generatedResult(produced);
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest({ prompt: "first" }));
    await client.query(agentRequest({ prompt: "second" }));
    const messages = messagesOf(1);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]!.content).toBe("first");
    expect(messages[1]!.content).toBe(JSON.stringify(produced));
    expect(messages[2]!.content).toBe("second");
  });

  test("a pass whose output parsed to undefined appends nothing rather than a non-string turn", async () => {
    respond = () => generatedResult(undefined);
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest({ prompt: "first" }));
    respond = () => generatedResult({ sections: [] });
    await client.query(agentRequest({ prompt: "second" }));
    expect(messagesOf(1).map((message) => message.role)).toEqual(["user"]);
  });

  test("a pass that produced no structured output leaves no half pair behind", async () => {
    respond = () => { throw noObjectGenerated("nope"); };
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest({ prompt: "first" }));
    respond = () => generatedResult({ sections: [] });
    await client.query(agentRequest({ prompt: "second" }));
    expect(messagesOf(1).map((message) => message.role)).toEqual(["user"]);
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
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });

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
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });

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
      "B",
      JSON.stringify({ sections: [{ heading: "B", markdown: "b" }] }),
      "C",
    ]);
  });

  test("an aborted pass loses even when no replacement ever ran, so the abort check is load-bearing", async () => {
    const a = deferred<unknown>();
    respond = () => a.promise;
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    const controller = new AbortController();
    const passA = client.query(agentRequest({ prompt: "A", signal: controller.signal }));
    await tick();
    controller.abort();
    a.settle(generatedResult({ sections: [{ heading: "A", markdown: "a" }] }));
    await passA.catch(() => {});

    respond = () => generatedResult({ sections: [] });
    await client.query(agentRequest({ prompt: "C" }));
    expect(messagesOf(1).map((message) => message.role)).toEqual(["user"]);
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
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH, maxHistoryCharacters: 1000 });
    await client.query(agentRequest({ prompt: "p".repeat(800) }));
    await client.query(agentRequest({ prompt: "q".repeat(800) }));
    await client.query(agentRequest({ prompt: "final" }));
    const messages = messagesOf(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]!.content).toBe("q".repeat(800));
    expect(messages[1]!.content).toBe(JSON.stringify(answer));
  });

  test("keeps a pair that fits, so the budget does not evict eagerly", async () => {
    respond = () => generatedResult({ sections: [{ heading: "H", markdown: "x".repeat(10) }] });
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH, maxHistoryCharacters: 1000 });
    await client.query(agentRequest({ prompt: "p".repeat(800) }));
    await client.query(agentRequest({ prompt: "q".repeat(800) }));
    expect(messagesOf(1).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });

  test("the system message and the current prompt are outside the budget and never evictable", async () => {
    // A budget that could evict the system message would silently drop the safety preamble.
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH, maxHistoryCharacters: 0 });
    await client.query(agentRequest({ prompt: "first" }));
    await client.query(agentRequest({ prompt: "second" }));
    const messages = messagesOf(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("second");
    // The system prompt is untouched: it is not in the array the budget walks at all.
    expect(instructionsOf(1).content).toBe(SYSTEM_PROMPT);
  });

  test("a budget smaller than the system prompt still leaves a working call", async () => {
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH, maxHistoryCharacters: 10 });
    await client.query(agentRequest({ prompt: "first" }));
    const response = await client.query(agentRequest({ prompt: "second" }));
    expect(response.structuredOutput).toBeDefined();
    expect(instructionsOf(1).content).toBe(SYSTEM_PROMPT);
  });

  const BAD_BUDGETS: Readonly<{ label: string; value: number }>[] = [
    { label: "negative", value: -1 },
    { label: "fractional", value: 1.5 },
    { label: "NaN", value: Number.NaN },
    { label: "infinite", value: Number.POSITIVE_INFINITY },
  ];

  test.each(BAD_BUDGETS)("rejects a $label history budget at construction, not at first use", ({ value }) => {
    expect(() => new LlmAgentClient({ profile: profile(), fetch: FETCH, maxHistoryCharacters: value }))
      .toThrow(/maxHistoryCharacters/);
  });
});

describe("LlmAgentClient against the real generateText", () => {
  test("the SDK accepts the call the client builds, and the provider sees the system prompt first", async () => {
    // Everything else in this suite replaces `generateText`, so nothing else reaches the
    // SDK's own prompt validation — and that is precisely where a system-role entry inside
    // `messages` is rejected outright, before any provider is touched. This replays the
    // client's OWN recorded options against the real implementation with only the model
    // swapped, so "we passed a system prompt" becomes "the SDK accepted it and the provider
    // saw it".
    const client = new LlmAgentClient({ profile: profile(), fetch: FETCH });
    await client.query(agentRequest({ prompt: "hi" }));

    const answer = { sections: [{ heading: "H", markdown: "m" }] };
    let promptSeen: readonly ModelMessageLike[] | undefined;
    const stubModel = {
      specificationVersion: "v3",
      provider: "stub",
      modelId: "stub-model",
      supportedUrls: {},
      doGenerate: async (options: Readonly<{ prompt: readonly ModelMessageLike[] }>) => {
        promptSeen = options.prompt;
        return {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          // v3 reports these as objects rather than bare values. A bare "stop" leaves
          // finishReason undefined, and `output` then throws NoOutputGeneratedError.
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        };
      },
    };

    const options = { ...calls[0], model: stubModel } as unknown as Parameters<typeof realGenerateText>[0];
    const result = await realGenerateText(options);

    expect(promptSeen?.[0]).toEqual({ role: "system", content: SYSTEM_PROMPT, providerOptions: CACHE_HINT });
    expect(promptSeen?.map((message) => message.role)).toEqual(["system", "user"]);
    expect(result.output).toEqual(answer);
  });
});
