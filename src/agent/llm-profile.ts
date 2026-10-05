/**
 * Which ordinary LLM provider to talk to via the Vercel AI SDK: provider id, model, and the
 * optional endpoint a given provider needs.
 *
 * `base_url` is required only for `openai-compatible`: that provider id names no fixed
 * endpoint of its own, so without a `base_url` there is nowhere to send the request.
 */
export type LlmProviderId = "openai" | "anthropic" | "ollama" | "openai-compatible";

/**
 * Everything the LLM backend needs to reach a provider, and deliberately no secret: the
 * Shorthand app holds the key and injects it into each request (`src/app/fetch.ts`), so
 * this process never sees one. `LlmAgentClient` takes this plus an app-backed `fetch`.
 */
export type LlmProfile = Readonly<{
  provider: LlmProviderId;
  model: string;
  base_url?: string;
}>;
