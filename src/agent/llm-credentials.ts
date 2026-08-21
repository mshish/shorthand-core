import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shorthandConfigDirectory } from "../config.js";

/**
 * The credentials file as core READS it: which ordinary LLM provider to talk to via the
 * Vercel AI SDK, and how — provider id, model, and the optional key/endpoint pair a given
 * provider needs.
 *
 * Core does not write this file, and there is no function here that does. One writer per
 * file — a file with two writers in two languages has an invariant that lives in neither
 * of them, and the merge such a scheme needs is exactly the class of silent data loss
 * removing the second writer removes. `src/testing/llm-credentials-conformance.ts` (a
 * later task) is the executable form of the contract a writer must satisfy.
 *
 * `api_key` is optional for EVERY provider, including `openai` and `anthropic`, not just
 * providers like a local Ollama endpoint that can plausibly run keyless. This is what lets
 * a user "clear my key" while preserving the rest of the profile, instead of writing a
 * file this reader rejects wholesale. A key that is genuinely required-and-absent is
 * caught later, where the requirement actually lives — constructing the OpenAI or
 * Anthropic client (`src/agent/llm-client.ts`, a later task) — with a message naming the
 * file the profile came from.
 *
 * `base_url` is required only for `openai-compatible`: that provider id names no fixed
 * endpoint of its own, so without a `base_url` there is nowhere to send the request.
 */
export type LlmProviderId = "openai" | "anthropic" | "openai-compatible";

export type LlmCredentials = Readonly<{
  provider: LlmProviderId;
  model: string;
  api_key?: string;
  base_url?: string;
}>;

export type LlmCredentialsReadResult =
  | Readonly<{ ok: true; value: LlmCredentials }>
  | Readonly<{ ok: false; message: string }>;

export function llmCredentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(shorthandConfigDirectory(environment), "llm-credentials.json");
}

const PROVIDER_IDS = ["openai", "anthropic", "openai-compatible"] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Reads and validates the credentials file. NEVER throws.
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
    return { ok: false, message: `LLM credentials at ${path} have provider ${JSON.stringify(record.provider)}; expected one of "openai", "anthropic", "openai-compatible".` };
  }
  const provider = record.provider;

  if (!nonEmptyString(record.model)) {
    return { ok: false, message: `LLM credentials at ${path} are missing a non-empty "model".` };
  }
  const model = record.model;

  // api_key is NOT required here for any provider: this function is about whether the
  // file parses into a well-formed profile, not whether the profile is enough to build a
  // working client. A local Ollama endpoint needs no key at all, and a user clearing their
  // key must still get back a valid (if incomplete) profile. The OpenAI/Anthropic client
  // constructors (src/agent/llm-client.ts) are the consumers that require a key, and they
  // report a clear error naming the file when one is absent.
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
