import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shorthandConfigDirectory } from "../config.js";

/**
 * The credentials file as core READS it: which ordinary LLM provider to talk to via the
 * Vercel AI SDK, and how — provider id, model, and the optional key/endpoint pair a given
 * provider needs.
 *
 * Legacy file, read once by the plugin's migration; removed in 0.23. Core does not write
 * it and never did, and there is no longer a conformance suite specifying its bytes: the
 * key it used to hold now lives in the Shorthand app's keyring, so the file has one reader
 * left and no future writer to hold to a contract.
 *
 * `api_key` is optional for EVERY provider, including `openai` and `anthropic`, not just
 * providers like a local Ollama endpoint that can plausibly run keyless: a user clearing
 * their key must still get back a valid profile rather than a file this reader rejects
 * wholesale.
 *
 * `base_url` is required only for `openai-compatible`: that provider id names no fixed
 * endpoint of its own, so without a `base_url` there is nowhere to send the request.
 */
export type LlmProviderId = "openai" | "anthropic" | "ollama" | "openai-compatible";

/**
 * Everything the LLM backend needs to reach a provider, and deliberately no secret: the
 * Shorthand app holds the key and injects it into each request (`src/app/fetch.ts`), so
 * this process never sees one. `LlmAgentClient` takes this plus an app-backed `fetch`.
 *
 * The same shape as `LlmCredentials` without `api_key`, and declared separately rather
 * than derived from it because the legacy file type below is on its way out and this is
 * not.
 */
export type LlmProfile = Readonly<{
  provider: LlmProviderId;
  model: string;
  base_url?: string;
}>;

/** Legacy file, read once by the plugin's migration; removed in 0.23. */
export type LlmCredentials = Readonly<{
  provider: LlmProviderId;
  model: string;
  api_key?: string;
  base_url?: string;
}>;

/** Legacy file, read once by the plugin's migration; removed in 0.23. */
export type LlmCredentialsReadResult =
  | Readonly<{ ok: true; value: LlmCredentials }>
  | Readonly<{ ok: false; message: string }>;

/** Legacy file, read once by the plugin's migration; removed in 0.23. */
export function llmCredentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(shorthandConfigDirectory(environment), "llm-credentials.json");
}

const PROVIDER_IDS = ["openai", "anthropic", "ollama", "openai-compatible"] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Reads and validates the credentials file. NEVER throws.
 *
 * Legacy file, read once by the plugin's migration; removed in 0.23.
 *
 * The writer is a different program, quite possibly in a different language, so a
 * malformed or partial file is ordinary input rather than a bug in core. It has to arrive
 * at the caller as a reportable configuration problem — an exception here surfaces mid-run
 * as a crash instead of as a message telling the user what to do.
 */
export async function readLlmCredentials(path = llmCredentialsPath()): Promise<LlmCredentialsReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, message: `No LLM credentials at ${path}; configure an LLM provider, then retry.` };
    }
    return { ok: false, message: `LLM credentials at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: `LLM credentials at ${path} are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: `LLM credentials at ${path} are not a JSON object.` };
  }

  const record = parsed as Record<string, unknown>;
  if (!isLlmProviderId(record.provider)) {
    return { ok: false, message: `LLM credentials at ${path} have provider ${JSON.stringify(record.provider)}; expected one of "openai", "anthropic", "ollama", "openai-compatible".` };
  }
  const provider = record.provider;

  if (!nonEmptyString(record.model)) {
    return { ok: false, message: `LLM credentials at ${path} are missing a non-empty "model".` };
  }
  const model = record.model;

  // api_key is NOT required here for any provider: this function is about whether the
  // file parses into a well-formed profile, not whether the profile is enough to build a
  // working client. A local Ollama endpoint needs no key at all, and a user clearing their
  // key must still get back a valid (if incomplete) profile. The migration that reads this
  // file simply has nothing to move when the key is absent.
  const apiKey = record.api_key;
  const baseUrl = record.base_url;

  // openai-compatible names no fixed endpoint of its own; without base_url the request has
  // nowhere to go. openai and anthropic have a default endpoint baked into their SDKs, so
  // base_url stays optional for them (an override, not a requirement).
  if (provider === "openai-compatible" && !nonEmptyString(baseUrl)) {
    return { ok: false, message: `LLM credentials at ${path} use provider "openai-compatible" but are missing "base_url"; the endpoint is unknowable without it.` };
  }

  return {
    ok: true,
    // Unknown top-level keys are dropped rather than rejected, and a present-but-empty
    // api_key/base_url is treated as absent rather than as a wrong-typed value — the same
    // forward-compatibility tolerance file-token-provider.ts documents for the Google
    // credentials file, for the same reason: a newer writer adding a field, or "clearing"
    // one to an empty string instead of omitting the key, must not break an older core.
    value: {
      provider,
      model,
      ...(nonEmptyString(apiKey) ? { api_key: apiKey } : {}),
      ...(nonEmptyString(baseUrl) ? { base_url: baseUrl } : {}),
    },
  };
}
