import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLlmCredentials } from "../src/agent/llm-credentials.js";
import type { LlmCredentials } from "../src/agent/llm-credentials.js";

const VALID: LlmCredentials = {
  provider: "openai",
  model: "gpt-5",
  api_key: "sk-test-1",
};

async function scratchPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "llm-credentials-"));
  return join(directory, "llm-credentials.json");
}

/** Test-only writer. Core is a pure reader; nothing under src/ writes this file. */
async function writeRaw(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  return path;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  return writeRaw(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("readLlmCredentials", () => {
  test("reads back every field of a well-formed file", async () => {
    const path = await writeJson(await scratchPath(), { ...VALID, base_url: "https://api.example.com/v1" });
    expect(await readLlmCredentials(path)).toEqual({
      ok: true,
      value: { ...VALID, base_url: "https://api.example.com/v1" },
    });
    await rm(path, { force: true });
  });

  test("round-trips a profile with no api_key: absent is legitimate, not an error", async () => {
    // Local Ollama needs no key, and clearing a key must not corrupt the rest of the
    // profile — the whole reason api_key is optional for every provider, not just the
    // providers that can plausibly run keyless.
    const partial: Record<string, unknown> = { ...VALID };
    delete partial.api_key;
    const result = await readLlmCredentials(await writeJson(await scratchPath(), partial));
    expect(result.ok).toBe(true);
    if (result.ok) expect("api_key" in result.value).toBe(false);
  });

  test("omits base_url entirely when the file has none", async () => {
    const result = await readLlmCredentials(await writeJson(await scratchPath(), VALID));
    expect(result.ok).toBe(true);
    if (result.ok) expect("base_url" in result.value).toBe(false);
  });

  test("reports an absent file without throwing, naming the path and a remedy", async () => {
    const result = await readLlmCredentials(await scratchPath());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("No LLM credentials at");
      // The remedy: what to do about it, not just what went wrong.
      expect(result.message.toLowerCase()).toContain("configure");
    }
  });

  test("reports non-JSON bytes without throwing", async () => {
    const result = await readLlmCredentials(await writeRaw(await scratchPath(), "not json at all"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not valid JSON");
  });

  test("reports a JSON value that is not an object without throwing", async () => {
    const result = await readLlmCredentials(await writeRaw(await scratchPath(), "[1,2,3]"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not a JSON object");
  });

  test("rejects an unknown provider by name", async () => {
    const path = await writeJson(await scratchPath(), { ...VALID, provider: "cohere" });
    const result = await readLlmCredentials(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"cohere"');
  });

  test("rejects an empty model", async () => {
    const path = await writeJson(await scratchPath(), { ...VALID, model: "" });
    const result = await readLlmCredentials(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("model");
  });

  test("rejects a missing model", async () => {
    const partial: Record<string, unknown> = { ...VALID };
    delete partial.model;
    const result = await readLlmCredentials(await writeJson(await scratchPath(), partial));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("model");
  });

  test("rejects openai-compatible without base_url, because the endpoint is unknowable without it", async () => {
    const path = await writeJson(await scratchPath(), {
      provider: "openai-compatible",
      model: "llama3",
      api_key: "sk-local",
    });
    const result = await readLlmCredentials(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("base_url");
      expect(result.message).toContain("openai-compatible");
    }
  });

  test("openai-compatible round-trips when base_url is present", async () => {
    const path = await writeJson(await scratchPath(), {
      provider: "openai-compatible",
      model: "llama3",
      base_url: "http://localhost:11434/v1",
    });
    expect(await readLlmCredentials(path)).toEqual({
      ok: true,
      value: {
        provider: "openai-compatible",
        model: "llama3",
        base_url: "http://localhost:11434/v1",
      },
    });
  });

  test("anthropic round-trips with no api_key present", async () => {
    // api_key is optional for EVERY provider at read time, including anthropic and
    // openai — a key that is genuinely required-and-absent is caught later, at client
    // construction (Task 4), not here.
    const path = await writeJson(await scratchPath(), { provider: "anthropic", model: "claude-opus-4" });
    expect(await readLlmCredentials(path)).toEqual({
      ok: true,
      value: { provider: "anthropic", model: "claude-opus-4" },
    });
  });

  test("ignores unknown top-level keys instead of rejecting them", async () => {
    // Forward compatibility: a newer writer adding a field must not break an older core.
    const path = await writeJson(await scratchPath(), { ...VALID, temperature: 0.2, future_field: 7 });
    expect(await readLlmCredentials(path)).toEqual({ ok: true, value: VALID });
  });
});
