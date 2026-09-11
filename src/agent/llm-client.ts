import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOllama } from "ai-sdk-ollama";
import { NoObjectGeneratedError, NoOutputGeneratedError, Output, generateText, jsonSchema } from "ai";
import type { CallWarning, LanguageModel, ModelMessage, SystemModelMessage } from "ai";
import { AgentQueryError, type AgentClient, type AgentQueryRequest, type AgentQueryResponse } from "./contract.js";
import type { LlmProfile, LlmProviderId } from "./llm-credentials.js";

/**
 * The second enhancement backend: ordinary LLM provider APIs through the Vercel AI SDK,
 * for users who have an OpenAI/Anthropic key or a local OpenAI-compatible endpoint but no
 * Claude Code install.
 *
 * No secret reaches this process. The caller supplies a `fetch` that performs the request
 * inside the Shorthand app (`createAppFetch`), and the app strips whatever authorization
 * header the SDK built before injecting the real key from its keyring. That is why the
 * profile carries no `api_key` and why the placeholder below is not a credential.
 *
 * Every `ai` / `@ai-sdk/*` import in the repository lives in this file alone, and that is
 * load-bearing in two directions: `mock.module` in one test suite cannot disturb another,
 * and an AI SDK major-version migration has exactly one file to touch.
 */

/**
 * A turn here can be a 40,000-character section array plus a requeued transcript delta, so a
 * turn count bounds nothing. The budget is in characters for that reason.
 *
 * It exists because `#history` would otherwise grow on every pass for up to the runner's
 * four-hour `maxDurationMs`, and unlike the Agent SDK there is no auto-compaction behind us
 * to notice: the request simply gets larger until the provider rejects it.
 */
export const DEFAULT_MAX_HISTORY_CHARACTERS = 120_000;

/**
 * NOT a credential, and not a secret: the OpenAI and Anthropic factories refuse to build
 * without an `apiKey` string, and the app strips the authorization header this produces
 * before injecting the real key. A recognisable placeholder is what makes it obvious in a
 * captured request that nothing here was ever supposed to authenticate.
 */
export const APP_MANAGED_API_KEY = "managed-by-shorthand";

export type LlmAgentClientOptions = Readonly<{
  profile: LlmProfile;
  /**
   * Required, and the only way out of this process: `createAppFetch(client, slot)` sends
   * the request through the Shorthand app, which holds the key. A default of
   * `globalThis.fetch` would silently make unauthenticated calls straight to the provider.
   */
  fetch: typeof globalThis.fetch;
  /** Character budget for retained history pairs. See `#commit` and `trimHistory`. */
  maxHistoryCharacters?: number;
  /** Per-request bound. The runner also races its own timeout around the whole contract. */
  timeoutMs?: number;
}>;

export class LlmAgentClient implements AgentClient {
  /**
   * There is no tool loop on this backend: no Read/Glob/Grep, so no vault lookups to
   * promise. The runner reads this and downgrades a link-tier pass to tick rather than
   * building a prompt that offers vault reads nothing will perform.
   */
  readonly supportsVaultTools = false;

  readonly #model: LanguageModel;
  readonly #providerId: LlmProviderId;
  readonly #modelId: string;
  readonly #maxHistoryCharacters: number;
  readonly #timeoutMs: number | undefined;
  /**
   * Identifies OUR conversation history, not a provider-side session: the chat-completions
   * shape is stateless, so there is nothing on the far end to resume. It is returned so the
   * runner has something stable to store and hand back.
   */
  readonly #sessionId = `llm-${globalThis.crypto.randomUUID()}`;
  /** Deduped per instance so a four-hour capture reports an exotic model id once, not per pass. */
  readonly #warnedOnce = new Set<string>();

  /**
   * Replaced wholesale rather than mutated, which is what makes "append the pair atomically,
   * never a half pair" structural instead of a rule to remember.
   */
  #history: readonly ModelMessage[] = [];
  #generation = 0;

  constructor(options: LlmAgentClientOptions) {
    const { profile } = options;
    // Rejected at construction, not at first use: a bad budget is a wiring mistake, and
    // discovering it forty minutes into a capture costs the pass that discovers it.
    // `Number.isInteger` covers NaN, both infinities, fractions and non-numbers at once.
    if (options.maxHistoryCharacters !== undefined
      && (!Number.isInteger(options.maxHistoryCharacters) || options.maxHistoryCharacters < 0)) {
      throw new Error(`maxHistoryCharacters must be a non-negative integer; received ${String(options.maxHistoryCharacters)}.`);
    }
    this.#maxHistoryCharacters = options.maxHistoryCharacters ?? DEFAULT_MAX_HISTORY_CHARACTERS;
    this.#timeoutMs = options.timeoutMs;
    this.#providerId = profile.provider;
    this.#modelId = profile.model;
    this.#model = buildModel(profile, options.fetch);
  }

  async query(request: AgentQueryRequest): Promise<AgentQueryResponse> {
    if (request.signal?.aborted === true) throw new AgentQueryError("Agent query aborted.");
    // Cannot fire in the intended lifecycle: the runner feeds back the id this instance
    // returned, and the plugin builds a fresh runner per capture and refuses a concurrent
    // second one. It catches a consumer wiring one client into two runners, which would
    // splice one meeting's transcript into another meeting's note.
    if (typeof request.sessionId === "string" && request.sessionId.length > 0 && request.sessionId !== this.#sessionId) {
      throw new AgentQueryError(
        `Session ${request.sessionId} belongs to a different capture; this client's session is ${this.#sessionId}. One LlmAgentClient serves one capture.`,
      );
    }

    // Claimed at entry, before the first await, so the ordering below is decided by when a
    // pass STARTED rather than by when it happened to settle.
    const generation = (this.#generation += 1);
    const historySnapshot = this.#history;
    const userMessage: ModelMessage = { role: "user", content: request.prompt };
    const messages: ModelMessage[] = [...historySnapshot, userMessage];

    let structuredOutput: unknown;
    let warnings: readonly CallWarning[] = [];
    try {
      const result = await generateText({
        model: this.#model,
        // jsonSchema() is required, not decorative: Output.object takes a FlexibleSchema
        // (Schema | LazySchema | ZodSchema | StandardSchema) and `outputSchema` arrives as a
        // plain Record<string, unknown> off the transport-neutral port, which is in none of them.
        output: Output.object({ schema: jsonSchema(request.outputSchema) }),
        // `instructions`, NOT a system-role entry in `messages`. `standardizePrompt` rejects
        // a system message inside `messages` outright — `allowSystemInMessages` defaults to
        // false, so the call throws InvalidPromptError before the provider is ever reached,
        // and that error is neither of the two we convert, so every pass would die fatal.
        // Taking a SystemModelMessage object rather than a bare string is what keeps the
        // Anthropic cache hint attached.
        instructions: systemMessage(request.systemPrompt),
        messages,
        // Deliberately NO maxOutputTokens: each provider derives one from the model, and a
        // second ceiling here would drift from model capabilities we do not control — a new
        // model with a bigger window would silently keep the old cap. Truncation is handled
        // instead by converting the NoOutputGeneratedError it produces, below.
        //
        // request.maxTurns is deliberately NOT forwarded either: it bounds an agentic tool
        // loop, and there is no tool loop on this backend for it to bound. `tools` and `cwd`
        // are ignored for the same reason — see `supportsVaultTools`.
        ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
        ...(this.#timeoutMs === undefined ? {} : { timeout: this.#timeoutMs }),
      });
      // Read before `output`, because the getter below can throw and the warnings are still
      // the best account of why it did.
      warnings = result.warnings ?? [];
      // The structured value lives at `output`, not `text` or `experimental_output`. This is
      // a getter, and it throws NoOutputGeneratedError when its backing value is null —
      // which happens whenever finishReason !== "stop", i.e. a length-truncated completion.
      structuredOutput = result.output;
    } catch (error) {
      const diagnostics = this.#diagnostics(errorMessage(error), warnings);
      // TWO throws, not one. Both mean "the turn ran and produced nothing usable", which the
      // contract loop can still correct with a clean second attempt; `queryForSections`
      // breaks its retry loop on ANY thrown error, so letting either escape costs that
      // attempt outright. NoObjectGeneratedError is a schema-parse failure;
      // NoOutputGeneratedError is the truncated completion described above.
      if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
        this.#reportWarnings(warnings);
        return { structuredOutput: undefined, sessionId: this.#sessionId, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
      }
      // Everything else genuinely ends the pass, so the message has to be actionable: the
      // provider and model are what a user changes in response. The provider's own text is
      // forwarded unedited — this process holds no secret that could be echoed back in a
      // 401 body, so there is nothing here to scrub out of it.
      throw new AgentQueryError(
        `LLM provider "${this.#providerId}" (model "${this.#modelId}") failed: ${errorMessage(error)}`,
      );
    }

    this.#reportWarnings(warnings);
    this.#commit(generation, request.signal, historySnapshot, userMessage, structuredOutput);
    const diagnostics = this.#diagnostics(undefined, warnings);
    return {
      // Passed through untouched. `validateSectionOutput` is the single judge of section
      // content; a second gate here would be the one that quietly drifts weaker.
      structuredOutput,
      sessionId: this.#sessionId,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  /**
   * The commit rule, and it is subtler than "drop the append if a newer pass already
   * appended". A timed-out pass keeps running after the runner abandons it, so it can settle
   * AFTER its replacement started but BEFORE the replacement appends — under the weaker rule
   * the abandoned pass would win that race and its turn would end up in the transcript the
   * live pass then builds on.
   *
   * So: the pass must still be the current generation, and its signal must not have aborted.
   */
  #commit(
    generation: number,
    signal: AbortSignal | undefined,
    historySnapshot: readonly ModelMessage[],
    userMessage: ModelMessage,
    structuredOutput: unknown,
  ): void {
    if (generation !== this.#generation || signal?.aborted === true) return;
    // `JSON.stringify(undefined)` is `undefined`, not a string, so an absent value would
    // append a message whose content is not a string and poison every later pass. Nothing
    // observed today returns one — the parse would have thrown first — but the cost of
    // being wrong is a corrupted conversation rather than one bad pass.
    if (structuredOutput === undefined) return;
    const assistantMessage: ModelMessage = {
      role: "assistant",
      // The serialized structured value, not `result.text`: under an object output the raw
      // text is provider-dependent and may be empty, whereas this is exactly what the model
      // committed to and what the next pass's sections are supposed to follow from.
      content: JSON.stringify(structuredOutput),
    };
    this.#history = trimHistory([...historySnapshot, userMessage, assistantMessage], this.#maxHistoryCharacters);
  }

  #diagnostics(detail: string | undefined, warnings: readonly CallWarning[]): readonly string[] {
    const entries = detail === undefined ? [] : [detail];
    for (const warning of warnings) entries.push(`provider warning: ${describeWarning(warning)}`);
    return entries.filter((entry) => entry.length > 0);
  }

  /**
   * `diagnostics` is only read by `validateSectionOutput` when `structuredOutput` is absent,
   * so a warning attached to a SUCCESSFUL pass never reaches a human — which defeats the
   * point of surfacing it, since the warning most worth seeing ("unknown model id, clamping
   * the token limit") arrives on passes that succeed. The console is the second outlet.
   */
  #reportWarnings(warnings: readonly CallWarning[]): void {
    for (const warning of warnings) {
      const text = describeWarning(warning);
      if (this.#warnedOnce.has(text)) continue;
      this.#warnedOnce.add(text);
      try { console.warn(`[enhance] LLM provider warning: ${text}`); } catch { /* Logging must not kill capture. */ }
    }
  }
}

/** The endpoint each provider talks to when the profile does not override it. */
const OPENAI_ORIGIN = "https://api.openai.com";
const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
/**
 * Ollama's own default, and the one `buildModel` passes the factory. `llmEndpointOrigin`
 * reads the same constant on purpose: the app compares each request URL's origin against
 * the slot origin the caller registered, so two constants naming this endpoint separately
 * would drift into rejecting every call as an origin mismatch.
 */
const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const MISSING_COMPATIBLE_BASE_URL =
  `Provider "openai-compatible" needs a base_url; the endpoint is unknowable without one.`;

/**
 * The `origin` of the credential slot this profile's requests belong to: `scheme://host`
 * with a port when the URL carries one, and never a path. The app rejects any request whose
 * URL origin differs from the slot's, so this has to be derived the same way the app
 * derives it — `URL.origin`, which also lower-cases the scheme and host for us.
 */
export function llmEndpointOrigin(profile: LlmProfile): string {
  const baseUrl = profile.base_url;
  switch (profile.provider) {
    case "openai":
      return originOf(baseUrl ?? OPENAI_ORIGIN);
    case "anthropic":
      return originOf(baseUrl ?? ANTHROPIC_ORIGIN);
    case "ollama":
      return originOf(baseUrl ?? OLLAMA_BASE_URL);
    case "openai-compatible":
      if (baseUrl === undefined) throw new Error(MISSING_COMPATIBLE_BASE_URL);
      return originOf(baseUrl);
  }
}

function originOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`base_url ${JSON.stringify(baseUrl)} is not an absolute URL, so it names no endpoint to authorise.`);
  }
  // `URL.origin` is the literal string "null" for a scheme with no origin of its own —
  // `file:`, `data:` — and handing that to the app as a slot origin fails there, one layer
  // further from the setting the user actually got wrong.
  if (url.origin === "null") {
    throw new Error(`base_url ${JSON.stringify(baseUrl)} has no origin; use an http or https URL.`);
  }
  return url.origin;
}

/**
 * `base_url` is honoured for all three providers, not only the compatible one: OpenAI and
 * Anthropic both accept a base URL for gateways, proxies and Azure-style deployments, and a
 * profile that accepts the field then ignores it for two of three providers is worse than
 * one that never accepted it. It stays *required* only for `openai-compatible`, where the
 * endpoint is unknowable without it.
 */
function buildModel(profile: LlmProfile, fetch: typeof globalThis.fetch): LanguageModel {
  const baseUrl = profile.base_url;
  const transport = {
    ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
    fetch,
  };
  switch (profile.provider) {
    // APP_MANAGED_API_KEY, not a real key: these two factories throw without an `apiKey`
    // string, and the app replaces the header it produces with the secret from its keyring.
    case "openai":
      return createOpenAI({ apiKey: APP_MANAGED_API_KEY, ...transport })(profile.model);
    case "anthropic":
      return createAnthropic({ apiKey: APP_MANAGED_API_KEY, ...transport })(profile.model);
    case "openai-compatible": {
      // Failing loudly beats posting to `undefined/chat/completions`.
      if (baseUrl === undefined) throw new Error(MISSING_COMPATIBLE_BASE_URL);
      return createOpenAICompatible({
        name: "openai-compatible",
        baseURL: baseUrl,
        // Not optional for this backend. The flag defaults to false, and a false value makes
        // the provider DROP the schema and send `response_format: {"type":"json_object"}`
        // instead — so the model is asked for unconstrained JSON, `Output.object` fails to
        // parse whatever comes back, and every pass burns the whole retry ladder before
        // reporting a generic invalid-output error. The other two providers send schemas
        // natively, so this silently broke local endpoints only. An endpoint that cannot
        // honour `json_schema` cannot serve a backend whose entire contract is a validated
        // section object, and failing its way is clearer than degrading into that ladder.
        supportsStructuredOutputs: true,
        // No apiKey at all, unlike the two above: this factory is happy without one, and a
        // local endpoint often authenticates nothing. When the slot does hold a secret the
        // app adds the header, so sending a placeholder here would buy nothing.
        fetch,
      })(profile.model);
    }
    case "ollama":
      return createOllama({ baseURL: baseUrl ?? OLLAMA_BASE_URL, fetch })(profile.model);
  }
}

function systemMessage(systemPrompt: string): SystemModelMessage {
  return {
    role: "system",
    // Verbatim and unmodified. ENHANCEMENT_SAFETY_PREAMBLE is composed into this string
    // upstream, so forwarding it untouched is the whole reason a user-supplied guidance
    // prompt is safe on this backend. Anything that reformats, truncates or wraps it here
    // silently removes the injection guard.
    content: systemPrompt,
    // Namespaced, so the two non-Anthropic providers ignore it rather than choke on it.
    // The minimum cacheable prompt length is model-dependent (1024-4096 tokens), so this is
    // an optimisation that silently no-ops on short prompts, not a guarantee of a cache hit.
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };
}

/**
 * Drops oldest user+assistant PAIRS, never a half pair: a history ending on a user turn with
 * no reply reads to the model as an unanswered question.
 *
 * The budget covers retained history only, and the system prompt is outside it by STRUCTURE
 * rather than by arithmetic: it travels as `generateText`'s `instructions` option and is
 * never an element of the array this function walks, so no trim bug — not an off-by-one, not
 * a future rewrite of the loop below — can reach it. That matters because evicting the
 * system message would silently drop ENHANCEMENT_SAFETY_PREAMBLE, and the pass would look
 * entirely healthy while doing it.
 *
 * The current pass's user message is likewise safe: the outgoing message array is built
 * before this runs, so a budget too small to retain the newest pair empties the history
 * without ever affecting the call that produced it.
 */
function trimHistory(messages: readonly ModelMessage[], budget: number): readonly ModelMessage[] {
  let characters = messages.reduce((total, message) => total + messageCharacters(message), 0);
  let start = 0;
  while (start + 1 < messages.length && characters > budget) {
    characters -= messageCharacters(messages[start]!) + messageCharacters(messages[start + 1]!);
    start += 2;
  }
  return messages.slice(start);
}

function messageCharacters(message: ModelMessage): number {
  return typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
}

function describeWarning(warning: CallWarning): string {
  switch (warning.type) {
    case "unsupported":
    case "compatibility":
      return `${warning.type}: ${warning.feature}${warning.details === undefined ? "" : ` (${warning.details})`}`;
    case "deprecated":
      return `deprecated: ${warning.setting} - ${warning.message}`;
    case "other":
      return warning.message;
    // Unreachable against today's union, but the SDK adds warning variants in minor
    // releases and an unprinted warning is worse than an ugly one.
    default:
      return JSON.stringify(warning);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
