import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClaudeAgentClient } from "../src/agent/client.js";
import { CodexAgentClient } from "../src/agent/codex-client.js";
import { AppUnavailableError } from "../src/app/client.js";
import type { AppClientLike } from "../src/app/client.js";
import type { PassOutcome } from "../src/agent/runner.js";
import { DEFAULT_CONFIG, requestSocketDiscoveryPath } from "../src/config.js";
import { SidecarWriter } from "../src/note/sidecar.js";
import { FakeAppClient } from "./fixtures/fake-app-client.js";

/**
 * The provider factories are stubbed so a CLI test can see what `selectAgent` handed the
 * LLM backend — specifically the app-backed `fetch`, which is otherwise sealed inside the
 * model the factory returns. Calling that captured fetch against a `FakeAppClient` is the
 * only way to observe the credential slot the CLI built, and the slot is the wire contract:
 * a wrong `provider` or `origin` is an `origin_mismatch` on every real request.
 *
 * Only `@ai-sdk/*` is replaced. Everything else the CLI touches — the Claude and Codex
 * clients, the runner, the sidecar — is the real module.
 */
type ProviderOptions = Record<string, unknown>;
const providerCalls: ProviderOptions[] = [];

function fakeProviderFactory() {
  return (options: ProviderOptions = {}) => {
    providerCalls.push(options);
    return (modelId: string) => ({ __model: modelId });
  };
}

mock.module("@ai-sdk/openai", () => ({ createOpenAI: fakeProviderFactory() }));
mock.module("@ai-sdk/anthropic", () => ({ createAnthropic: fakeProviderFactory() }));
mock.module("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: fakeProviderFactory() }));
mock.module("ai-sdk-ollama", () => ({ createOllama: fakeProviderFactory() }));

// Imported after the mocks are registered, for the reason test/llm-client.test.ts documents:
// these modules read the provider factories at call time through live bindings, so the
// registration has to happen before the module graph that reaches them is evaluated.
const { createEnhanceRunner, runCli, runFinalEnhancementWithRetries, selectAgent } = await import("../bin/shorthand-notes.js");
const { LlmAgentClient } = await import("../src/agent/llm-client.js");

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// The codex-backend tests below construct a CodexAgentClient through selectAgent and never
// call query() today, so CODEX_HOME is never actually read — safe by accident, not by design.
// Guarded anyway, the same way test/codex-client.test.ts guards its whole file: a future test
// that does add a query() call must not be able to hardlink this machine's real ~/.codex
// credentials into a leaked temp dir just because this file forgot to isolate the environment.
let originalCliCodexHome: string | undefined;
let emptyCliCodexHome: string;
const cliCodexClients: CodexAgentClient[] = [];
beforeAll(async () => {
  originalCliCodexHome = process.env.CODEX_HOME;
  emptyCliCodexHome = await mkdtemp(join(tmpdir(), "shorthand-codex-cli-ambient-"));
  process.env.CODEX_HOME = emptyCliCodexHome;
});
afterAll(async () => {
  await Promise.all(cliCodexClients.splice(0).map((client) => client.dispose()));
  if (originalCliCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCliCodexHome;
  await rm(emptyCliCodexHome, { recursive: true, force: true });
});

describe("shorthand-notes CLI", () => {
  test("final enhancement retries requeued and timed-out outcomes with backoff", async () => {
    const outcomes: PassOutcome[] = [
      { status: "requeued", reason: "busy" },
      { status: "timed-out" },
      { status: "completed", tier: "link", sections: [], written: true },
    ];
    const delays: number[] = [];
    const outcome = await runFinalEnhancementWithRetries(
      { enhanceNow: async () => outcomes.shift()! },
      async (milliseconds) => { delays.push(milliseconds); },
    );
    expect(outcome.status).toBe("completed");
    expect(delays).toEqual([200, 500]);
  });

  test("final enhancement prefers the target's own retryAfterMs over the fixed ladder", async () => {
    const outcomes: PassOutcome[] = [
      { status: "requeued", reason: "busy", retryAfterMs: 1_500 },
      { status: "requeued", reason: "busy" },
      { status: "completed", tier: "link", sections: [], written: true },
    ];
    const delays: number[] = [];
    const outcome = await runFinalEnhancementWithRetries(
      { enhanceNow: async () => outcomes.shift()! },
      async (milliseconds) => { delays.push(milliseconds); },
    );
    expect(outcome.status).toBe("completed");
    // First delay is the target's Retry-After; the second falls back to the ladder.
    expect(delays).toEqual([1_500, 500]);
  });

  test("final enhancement returns the third failure for a non-zero capture exit", async () => {
    let calls = 0;
    const outcome = await runFinalEnhancementWithRetries(
      { enhanceNow: async () => { calls += 1; return { status: "requeued", reason: "stale" }; } },
      async () => {},
    );
    expect(outcome).toEqual({ status: "requeued", reason: "stale" });
    expect(calls).toBe(3);
  });

  test("enhance dry-run uses an executable agent stub and does not write the note", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-enhance-stub-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const transcript = join(vault, "transcript.md");
    const original = "<!-- shorthand:notes -->\n- mine\n<!-- shorthand:ai:start -->\n## Summary\nOld\n<!-- shorthand:ai:end -->";
    await writeFile(note, original, "utf8");
    await writeFile(transcript, "me: offline transcript", "utf8");
    const result = await run(join(process.cwd(), "bin", "shorthand-notes.ts"), [
      "enhance", "--vault", vault, "--note", "meeting.md", "--transcript", "transcript.md",
      "--tier", "tick", "--dry-run", "--agent-stub", join(process.cwd(), "test", "fixtures", "fake-agent.mjs"),
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ heading: "Stub summary", markdown: "Offline result" }]);
    expect(await readFile(note, "utf8")).toBe(original);
  });

  test("capture --enhance keeps capturing and runs the final link pass through the offline stub", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-capture-enhance-test-"));
    scratchDirectories.push(vault);
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    expect((await run(entry, [
      "init-note", "--vault", vault, "--note", "meeting.md", "--sidecar", "transcript.md",
    ])).code).toBe(0);
    const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
    const agentStub = join(process.cwd(), "test", "fixtures", "fake-agent.mjs");
    const result = await run(entry, [
      "capture", "--vault", vault, "--note", "meeting.md", "--fake-stream", fixture,
      "--no-reconnect", "--enhance", "--agent-stub", agentStub,
    ]);
    expect(result.code).toBe(0);
    expect(await readFile(join(vault, "transcript.md"), "utf8")).toContain("# Shorthand Transcript");
    expect(await readFile(join(vault, "meeting.md"), "utf8")).toContain("## Stub summary\nOffline result");
  }, 10_000);

  test("runs capture with an explicit fake stream and links a pre-existing note without changing its content", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-smoke-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const sidecar = join(vault, "transcript.md");
    const originalNote = "# Meeting\n\nUser-owned notes.\n";
    await writeFile(note, originalNote, "utf8");
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
    const result = await run(entry, [
      "capture",
      "--vault", vault,
      "--note", "meeting.md",
      "--sidecar", "transcript.md",
      "--fake-stream", fixture,
      "--no-reconnect",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Sidecar written: ${sidecar}`);
    const linkedNote = await readFile(note, "utf8");
    expect(linkedNote).toStartWith('---\nshorthand-transcript: "[[transcript]]"\n---\n');
    expect(linkedNote.slice(linkedNote.indexOf(originalNote))).toBe(originalNote);
    expect(await readFile(sidecar, "utf8")).toContain("# Shorthand Transcript");
  }, 10_000);

  test("init-note creates a linked scaffold without overwriting an existing note", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-init-test-"));
    scratchDirectories.push(vault);
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const args = [
      "init-note",
      "--vault", vault,
      "--note", "Meetings/standup.md",
      "--title", "Weekly Standup",
      "--sidecar", "Meetings/Transcripts/standup.md",
    ];
    const first = await run(entry, args);
    expect(first.code).toBe(0);
    const note = join(vault, "Meetings", "standup.md");
    const content = await readFile(note, "utf8");
    expect(content).toContain('shorthand-transcript: "[[Meetings/Transcripts/standup]]"');
    expect(content).toContain("# Weekly Standup\n\n<!-- shorthand:notes -->");
    expect(content).toContain("<!-- shorthand:ai:start -->\n## Summary");
    const second = await run(entry, args);
    expect(second.code).toBe(1);
    expect(await readFile(note, "utf8")).toBe(content);
  });

  test("set-sections writes through the block writer and preserves user bytes", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-set-sections-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const json = join(vault, "sections.json");
    const original = "user\tbytes  \r\n<!-- shorthand:ai:start -->\r\n## Old\r\n<!-- shorthand:ai:end -->tail";
    await writeFile(note, original, "utf8");
    await writeFile(json, JSON.stringify([{ heading: "Summary", markdown: "Done" }]), "utf8");
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const result = await run(entry, ["set-sections", "--note", note, "--json", json, "--force"]);
    expect(result.code).toBe(0);
    expect(await readFile(note, "utf8")).toBe(
      "user\tbytes  \r\n<!-- shorthand:ai:start -->\r\n## Summary\r\nDone\r\n<!-- shorthand:ai:end -->tail",
    );
  });

  test("read-block supplies a hash and set-sections rejects a stale expected hash without writing", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-stale-hash-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const json = join(vault, "sections.json");
    const original = "before\n<!-- shorthand:ai:start -->\n## Old\n<!-- shorthand:ai:end -->\nafter";
    await writeFile(note, original, "utf8");
    await writeFile(json, JSON.stringify([{ heading: "Summary", markdown: "New" }]), "utf8");
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");

    const read = await run(entry, ["read-block", "--vault", vault, "--note=meeting.md"]);
    expect(read.code).toBe(0);
    const snapshot = JSON.parse(read.stdout) as { body: string; sha256: string };
    expect(snapshot.body).toBe("\n## Old\n");
    expect(snapshot.sha256).toMatch(/^[a-f\d]{64}$/);

    const stale = await run(entry, [
      "set-sections", "--vault", vault, "--note", "meeting.md", "--json", json,
      "--expect-hash", "0".repeat(64),
    ]);
    expect(stale.code).toBe(3);
    expect(stale.stderr).toContain("AI block changed");
    expect(await readFile(note, "utf8")).toBe(original);
  });

  test("set-sections requires an expected hash unless force is explicit", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-force-gate-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const json = join(vault, "sections.json");
    const original = "<!-- shorthand:ai:start -->\n<!-- shorthand:ai:end -->";
    await writeFile(note, original, "utf8");
    await writeFile(json, "[]", "utf8");
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const result = await run(entry, ["set-sections", "--note", note, "--json", json]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires --expect-hash");
    expect(await readFile(note, "utf8")).toBe(original);
  });

  test("rejects a missing known-flag value instead of silently using a default", async () => {
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const result = await run(entry, ["read-block", "--vault", "--note", "meeting.md"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--vault requires a value");
  });

  test("google-login is gone: it is an unknown command and the usage text does not offer it", async () => {
    // There is no --help flag — runCli dispatches on the first positional and falls
    // through to usage() for anything unrecognised — so an unknown command IS the way to
    // read the usage text. Asserting on the text as well as the exit code is what catches
    // a half-deletion that removes the dispatch arm but leaves the advertisement.
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const result = await run(entry, ["google-login"], withoutGoogleOAuthEnv());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Expected capture, enhance, init-note, read-block, or set-sections.");
    expect(result.stderr).not.toContain("google-login");
    expect(result.stderr).not.toContain("--client-id");
  });

  test("capture inserts only the transcript key in existing frontmatter", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-frontmatter-link-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const originalBody = "# Meeting\n\nUser text with\ttabs and café.\n";
    await writeFile(note, `---\nowner: human\n---\n${originalBody}`, "utf8");
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
    const result = await run(entry, [
      "capture", "--vault", vault, "--note", "meeting.md", "--sidecar", "linked/transcript.md",
      "--fake-stream", fixture, "--no-reconnect",
    ]);
    expect(result.code).toBe(0);
    expect(await readFile(note, "utf8")).toBe(
      `---\nowner: human\nshorthand-transcript: "[[linked/transcript]]"\n---\n${originalBody}`,
    );
  }, 10_000);

  test("capture follows the scaffold's sidecar link while leaving the meeting note unchanged", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-linked-capture-test-"));
    scratchDirectories.push(vault);
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    expect((await run(entry, [
      "init-note", "--vault", vault, "--note", "meeting.md", "--sidecar", "linked/transcript.md",
    ])).code).toBe(0);
    const note = join(vault, "meeting.md");
    const original = await readFile(note, "utf8");
    const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
    const capture = await run(entry, [
      "capture", "--vault", vault, "--note", "meeting.md", "--fake-stream", fixture, "--no-reconnect",
    ]);
    expect(capture.code).toBe(0);
    expect(await readFile(note, "utf8")).toBe(original);
    expect(await readFile(join(vault, "linked", "transcript.md"), "utf8")).toContain("# Shorthand Transcript");
  }, 10_000);

  test("enhance rejects an invalid --sink value", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-sink-invalid-test-"));
    scratchDirectories.push(vault);
    await writeFile(join(vault, "meeting.md"), "# Meeting\n", "utf8");
    await writeFile(join(vault, "transcript.md"), "me: hi", "utf8");
    const result = await run(join(process.cwd(), "bin", "shorthand-notes.ts"), [
      "enhance", "--vault", vault, "--note", "meeting.md", "--transcript", "transcript.md", "--sink", "notion",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--sink must be markdown or google.");
  });

  test("capture --enhance rejects an invalid --sink value", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-capture-sink-invalid-test-"));
    scratchDirectories.push(vault);
    await writeFile(join(vault, "meeting.md"), "# Meeting\n", "utf8");
    const result = await run(join(process.cwd(), "bin", "shorthand-notes.ts"), [
      "capture", "--vault", vault, "--note", "meeting.md", "--enhance", "--sink", "notion",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--sink must be markdown or google.");
  });

  test("enhance --sink google fails clearly, without naming any consumer app, when no Google credentials are configured", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-sink-google-nocreds-test-"));
    scratchDirectories.push(vault);
    const configDirectory = await mkdtemp(join(tmpdir(), ".cli-sink-google-config-"));
    scratchDirectories.push(configDirectory);
    await writeFile(join(vault, "meeting.md"), "# Meeting\n", "utf8");
    await writeFile(join(vault, "transcript.md"), "me: hi", "utf8");
    const result = await run(
      join(process.cwd(), "bin", "shorthand-notes.ts"),
      ["enhance", "--vault", vault, "--note", "meeting.md", "--transcript", "transcript.md", "--sink", "google"],
      withoutGoogleOAuthEnv({ APPDATA: configDirectory, XDG_CONFIG_HOME: configDirectory, HOME: configDirectory, USERPROFILE: configDirectory }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("connect your Google account");
    expect(result.stderr).not.toContain("shorthand-config");
  }, 10_000);

  test("capture --sink google fails before the recording stream starts when no Google credentials are configured", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-capture-sink-nocreds-test-"));
    scratchDirectories.push(vault);
    const configDirectory = await mkdtemp(join(tmpdir(), ".cli-capture-sink-config-"));
    scratchDirectories.push(configDirectory);
    await writeFile(join(vault, "meeting.md"), "# Meeting\n\nUser-owned notes.\n", "utf8");
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
    const result = await run(
      entry,
      ["capture", "--vault", vault, "--note", "meeting.md", "--fake-stream", fixture, "--no-reconnect", "--enhance", "--sink", "google"],
      withoutGoogleOAuthEnv({ APPDATA: configDirectory, XDG_CONFIG_HOME: configDirectory, HOME: configDirectory, USERPROFILE: configDirectory }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No Google credentials");
    expect(result.stdout).not.toContain("Sidecar written");
    await expect(readFile(join(vault, "transcript.md"), "utf8")).rejects.toThrow();
  }, 10_000);

  test("run() strips GOOGLE_OAUTH_CLIENT_ID/SECRET from any env it's given", async () => {
    // Retargeted, and deliberately weaker than the version it replaces. The original
    // probed `google-login`, which failed fast without a credential, so a leak showed up
    // as the command NOT failing — that is, as a browser opening. `google-login` was
    // deleted when core stopped performing consent, and no surviving command has that
    // shape, so this asserts the property directly instead: the two keys are absent from
    // the env run() hands to spawn. It proves the strip happens; it no longer proves that
    // nothing can open a consent window.
    //
    // Why the strip is load-bearing at all, kept from the original: run()'s default `env`
    // parameter is process.env, which (via Bun's dotenv auto-load of a real local .env)
    // can carry real Google OAuth credentials. A real incident — a test spawning a browser
    // with them — is what prompted the unconditional strip at run()'s spawn site. Every
    // other caller in this file also called withoutGoogleOAuthEnv(), so the property held
    // only by caller discipline. This test deliberately does NOT call it.
    const probe = join(process.cwd(), "test", "fixtures", "print-google-env.mjs");
    const result = await run(probe, [], {
      ...process.env,
      GOOGLE_OAUTH_CLIENT_ID: "leaked-via-inherited-env",
      GOOGLE_OAUTH_CLIENT_SECRET: "leaked-via-inherited-env",
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: null,
      GOOGLE_OAUTH_CLIENT_SECRET: null,
    });
  });

  test("--no-env-file prevents .env file leaks to subprocesses", async () => {
    // Same retarget, same weakening, same reason as the test above. This half proves the
    // other door: even with a .env sitting in the child's working directory, run()'s
    // --no-env-file flag stops the runtime loading it, so withoutGoogleOAuthEnv()'s intent
    // survives into the subprocess.
    const scratchDir = await mkdtemp(join(tmpdir(), ".cli-env-isolation-test-"));
    scratchDirectories.push(scratchDir);
    await writeFile(
      join(scratchDir, ".env"),
      "GOOGLE_OAUTH_CLIENT_ID=fake-leaked-id\nGOOGLE_OAUTH_CLIENT_SECRET=fake-leaked-secret\n",
      "utf8",
    );
    const probe = join(process.cwd(), "test", "fixtures", "print-google-env.mjs");
    const result = await run(probe, [], withoutGoogleOAuthEnv(), scratchDir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: null,
      GOOGLE_OAUTH_CLIENT_SECRET: null,
    });
  });

  describe("--backend selection", () => {
    test("defaults to the Claude Agent SDK backend when neither --backend nor --agent-stub is given", async () => {
      const result = await selectAgent([], {});
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(ClaudeAgentClient);
    });

    test.each([
      ["--backend", "llm"],
      ["--backend=llm", undefined],
    ])("%s parses and selects the LLM backend", async (flag, value) => {
      const args = value === undefined ? [flag] : [flag, value];
      const result = await selectAgent(
        [...args, "--llm-provider", "openai", "--llm-model", "gpt-5"],
        {},
        connectFake(),
      );
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(LlmAgentClient);
    });

    test("an unknown --backend value is a usage error, not a runtime one", async () => {
      await expect(selectAgent(["--backend", "bogus"], {})).rejects.toThrow("--backend must be claude, llm, or codex.");
    });

    test("names the slot the app holds the key under: kind, provider, and the profile's origin", async () => {
      // The app compares this origin against every request URL and refuses a mismatch before
      // any network I/O, so the slot the CLI builds is wire contract, not an internal detail.
      const client = new FakeAppClient();
      const result = await selectAgent(
        ["--backend", "llm", "--llm-provider", "openai", "--llm-model", "gpt-5"],
        {},
        async () => client,
      );
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(await slotOfNextFetch(client, "https://api.openai.com/v1/chat/completions")).toEqual({
        kind: "notes-llm", provider: "openai", origin: "https://api.openai.com",
      });
    });

    test("--llm-base-url reaches both the model's transport and the slot origin", async () => {
      const client = new FakeAppClient();
      const result = await selectAgent(
        ["--backend", "llm", "--llm-provider", "openai-compatible", "--llm-model", "local-model",
          "--llm-base-url", "http://127.0.0.1:1234/v1"],
        {},
        async () => client,
      );
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(providerCalls.at(-1)?.baseURL).toBe("http://127.0.0.1:1234/v1");
      expect(await slotOfNextFetch(client, "http://127.0.0.1:1234/v1/chat/completions")).toEqual({
        kind: "notes-llm", provider: "openai-compatible", origin: "http://127.0.0.1:1234",
      });
    });

    test("falls back to HANDY_NOTES_LLM_PROVIDER/MODEL/BASE_URL when the flags are absent", async () => {
      const client = new FakeAppClient();
      const result = await selectAgent(["--backend", "llm"], {
        HANDY_NOTES_LLM_PROVIDER: "openai-compatible",
        HANDY_NOTES_LLM_MODEL: "local-model",
        HANDY_NOTES_LLM_BASE_URL: "http://127.0.0.1:1234/v1",
      }, async () => client);
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(providerCalls.at(-1)?.baseURL).toBe("http://127.0.0.1:1234/v1");
    });

    test.each([
      ["--llm-model absent", ["--llm-provider", "openai"]],
      ["--llm-provider absent", ["--llm-model", "gpt-5"]],
      ["both absent", []],
    ])("reports what --backend llm needs when %s", async (_label, extra) => {
      const connect = connectFake();
      const result = await selectAgent(["--backend", "llm", ...extra], {}, connect);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toBe("--backend llm needs --llm-provider and --llm-model.");
    });

    test("an unknown --llm-provider is a usage error, the same way an unknown --backend is", async () => {
      await expect(selectAgent(["--backend", "llm", "--llm-provider", "bogus", "--llm-model", "m"], {}, connectFake()))
        .rejects.toThrow("--llm-provider must be openai, anthropic, ollama, or openai-compatible.");
    });

    test("Shorthand not running is reported as something the user can act on", async () => {
      const result = await selectAgent(
        ["--backend", "llm", "--llm-provider", "openai", "--llm-model", "gpt-5"],
        {},
        async () => {
          throw new AppUnavailableError("not-running", "Shorthand is not running: it has published no request socket.");
        },
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toBe("Shorthand is not running. Open the Shorthand app, then retry.");
    });

    test("an app too old to speak the request-socket protocol names the version to upgrade to", async () => {
      const result = await selectAgent(
        ["--backend", "llm", "--llm-provider", "openai", "--llm-model", "gpt-5"],
        {},
        async () => {
          throw new AppUnavailableError("too-old", "Shorthand 0.4.0 speaks request-socket protocol 0; this build needs protocol 1.", "0.4.0");
        },
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toBe("Update Shorthand to 0.5.0 or newer.");
    });

    test("an app NEWER than this build keeps the client's own message, which says so", async () => {
      // "Update Shorthand" would be actively wrong here: the app is ahead, and it is this
      // build that needs upgrading.
      const result = await selectAgent(
        ["--backend", "llm", "--llm-provider", "openai", "--llm-model", "gpt-5"],
        {},
        async () => {
          throw new AppUnavailableError("protocol", "Shorthand 0.9.0 speaks request-socket protocol 2, newer than the protocol 1 this build understands.", "0.9.0");
        },
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain("newer than the protocol 1 this build understands");
    });

    test("a base url with no usable origin fails before a connection is opened", async () => {
      // The origin is what the slot is registered under, so it has to be computable before
      // there is an app client to close again.
      let connectCalls = 0;
      const result = await selectAgent(
        ["--backend", "llm", "--llm-provider", "openai-compatible", "--llm-model", "m", "--llm-base-url", "file:///models"],
        {},
        async () => {
          connectCalls += 1;
          return new FakeAppClient();
        },
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toMatch(/http or https/);
      expect(connectCalls).toBe(0);
    });

    test("hands back a closeApp that releases the request socket", async () => {
      const client = new FakeAppClient();
      const result = await selectAgent(
        ["--backend", "llm", "--llm-provider", "openai", "--llm-model", "gpt-5"],
        {},
        async () => client,
      );
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(client.closed).toBe(false);
      result.closeApp?.();
      expect(client.closed).toBe(true);
    });

    test("the LLM backend reports it cannot drive vault tools, which is what downgrades a link pass", async () => {
      const result = await selectAgent(
        ["--backend", "llm", "--llm-provider", "openai", "--llm-model", "gpt-5"],
        {},
        connectFake(),
      );
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent.supportsVaultTools).toBe(false);
    });

    test("rejects --claude combined with --backend llm instead of silently ignoring one", async () => {
      await expect(selectAgent(["--backend", "llm", "--claude", "C:\\fake\\claude.exe"], {}))
        .rejects.toThrow("--claude cannot be combined with --backend llm");
    });

    test("parses --backend codex and selects the Codex backend", async () => {
      const result = await selectAgent(["--backend", "codex"], {});
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(CodexAgentClient);
      cliCodexClients.push(result.agent as CodexAgentClient);
    });

    test("--codex-exe is resolved into the Codex client's codexPathOverride via detectCodexExecutable", async () => {
      const result = await selectAgent(["--backend", "codex", "--codex-exe", "C:\\tools\\codex.exe"], {});
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(CodexAgentClient);
      cliCodexClients.push(result.agent as CodexAgentClient);
    });

    test("--codex-model is resolved into the Codex client via resolveCodexModel", async () => {
      const result = await selectAgent(["--backend", "codex", "--codex-model", "gpt-5.6-codex"], {});
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(CodexAgentClient);
      cliCodexClients.push(result.agent as CodexAgentClient);
    });

    test("SHORTHAND_CODEX_MODEL is honoured when --codex-model is not passed", async () => {
      const result = await selectAgent(["--backend", "codex"], { SHORTHAND_CODEX_MODEL: "gpt-5.6-codex" });
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(CodexAgentClient);
      cliCodexClients.push(result.agent as CodexAgentClient);
    });

    test("--codex-base-url is resolved into the Codex client via resolveCodexBaseUrl", async () => {
      const result = await selectAgent(["--backend", "codex", "--codex-base-url", "https://compliance.example/v1"], {});
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(CodexAgentClient);
      cliCodexClients.push(result.agent as CodexAgentClient);
    });

    test("SHORTHAND_CODEX_BASE_URL is honoured when --codex-base-url is not passed", async () => {
      const result = await selectAgent(["--backend", "codex"], { SHORTHAND_CODEX_BASE_URL: "https://env.example/v1" });
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(CodexAgentClient);
      cliCodexClients.push(result.agent as CodexAgentClient);
    });

    test("rejects --claude combined with --backend codex", async () => {
      await expect(selectAgent(["--backend", "codex", "--claude", "C:\\fake\\claude.exe"], {}))
        .rejects.toThrow("--claude cannot be combined with --backend codex");
    });

    test("--agent-stub wins over --backend, and never reaches the app at all", async () => {
      let connectCalls = 0;
      const result = await selectAgent(
        ["--backend", "llm", "--agent-stub", join(process.cwd(), "test", "fixtures", "fake-agent.mjs")],
        {},
        async () => {
          connectCalls += 1;
          return new FakeAppClient();
        },
      );
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).not.toBeInstanceOf(LlmAgentClient);
      expect(result.agent).not.toBeInstanceOf(ClaudeAgentClient);
      expect(connectCalls).toBe(0);
    });

    test("capture --backend llm runs the tick tier, since the LLM backend cannot drive vault tools", async () => {
      const vault = await mkdtemp(join(tmpdir(), ".cli-capture-llm-tick-test-"));
      scratchDirectories.push(vault);
      const configDirectory = await mkdtemp(join(tmpdir(), ".cli-capture-llm-config-"));
      scratchDirectories.push(configDirectory);
      const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
      expect((await run(entry, [
        "init-note", "--vault", vault, "--note", "meeting.md", "--sidecar", "transcript.md",
      ])).code).toBe(0);
      // The only test that exercises selectAgent's DEFAULT connectApp — a real
      // ShorthandAppClient, a real discovery file, a real socket — because in a subprocess
      // there is nothing to inject. The stand-in app says hello and then answers nothing, so
      // the enhancement pass hangs on its first http.fetch. That is enough: the tier is
      // decided before the request is ever sent (runner.ts:189-191), so
      // runUntilStderrContains kills the child the moment "started (tick)" appears.
      const app = await startStandInApp(configDirectory);
      try {
        const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
        const stderr = await runUntilStderrContains(entry, [
          "capture", "--vault", vault, "--note", "meeting.md", "--fake-stream", fixture,
          "--no-reconnect", "--enhance", "--backend", "llm",
          "--llm-provider", "openai-compatible", "--llm-model", "local-model",
          "--llm-base-url", "http://127.0.0.1:1234/v1",
        ], app.environment, "started (tick)");
        expect(stderr).toContain("started (tick)");
      } finally {
        await app.close();
      }
    }, 15_000);

    test("capture --backend llm stops with the app's own message when Shorthand is not running", async () => {
      const vault = await mkdtemp(join(tmpdir(), ".cli-capture-llm-noapp-test-"));
      scratchDirectories.push(vault);
      const configDirectory = await mkdtemp(join(tmpdir(), ".cli-capture-llm-noapp-config-"));
      scratchDirectories.push(configDirectory);
      const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
      expect((await run(entry, [
        "init-note", "--vault", vault, "--note", "meeting.md", "--sidecar", "transcript.md",
      ])).code).toBe(0);
      const result = await run(entry, [
        "capture", "--vault", vault, "--note", "meeting.md",
        "--fake-stream", join(process.cwd(), "test", "fixtures", "fake-stream.mjs"),
        "--no-reconnect", "--enhance", "--backend", "llm",
        "--llm-provider", "openai", "--llm-model", "gpt-5",
      ], redirectConfigDirectory(configDirectory));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Shorthand is not running. Open the Shorthand app, then retry.");
    }, 15_000);
  });

  test("capture teardown cancels the live interval timer before a sidecar close failure", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-teardown-timer-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const sidecar = join(vault, "transcript.md");
    const fixture = join(vault, "timer-stream.mjs");
    await writeFile(
      note,
      "<!-- shorthand:notes -->\n- mine\n<!-- shorthand:ai:start -->\n## Summary\nOld\n<!-- shorthand:ai:end -->",
      "utf8",
    );
    await writeFile(
      fixture,
      `process.stdout.write('{"t":"hello","protocol":1,"version":"test","emitted_at":"now"}\\n');
process.stdout.write('{"t":"begin","session":1,"streaming":true,"emitted_at":"now","session_elapsed_ms":0}\\n');
process.stdout.write(JSON.stringify({t:"partial",session:1,speaker:"me",committed:"a".repeat(200),tentative:"",emitted_at:"now",session_elapsed_ms:1})+"\\n");
await new Promise((resolve) => setTimeout(resolve, 1500));
process.stdout.write(JSON.stringify({t:"partial",session:1,speaker:"me",committed:"a".repeat(200)+"b".repeat(200),tentative:"",emitted_at:"now",session_elapsed_ms:2})+"\\n");
await new Promise((resolve) => setTimeout(resolve, 100));
process.stdout.write('{"t":"final","session":1,"speaker":"me","text":"done","emitted_at":"now","session_elapsed_ms":3}\\n');`,
      "utf8",
    );
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    const closeSpy = spyOn(SidecarWriter.prototype, "close").mockRejectedValue(new Error("close failed"));
    const exitListenersBefore = process.listenerCount("exit");
    try {
      await expect(runCli([
        "capture", "--vault", vault, "--note", note, "--sidecar", sidecar,
        "--fake-stream", fixture, "--no-reconnect", "--enhance", "--agent-stub",
        join(process.cwd(), "test", "fixtures", "fake-agent.mjs"),
      ], process.env)).rejects.toThrow("close failed");
      const intervalIndex = setTimeoutSpy.mock.calls.findIndex((call) => (
        typeof call[1] === "number" && call[1] > 20_000 && call[1] <= DEFAULT_CONFIG.thresholds.enhancementIntervalMs
      ));
      expect(intervalIndex).toBeGreaterThanOrEqual(0);
      const intervalTimer = setTimeoutSpy.mock.results[intervalIndex]!.value;
      expect(clearTimeoutSpy.mock.calls.some((call) => call[0] === intervalTimer)).toBe(true);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
    } finally {
      closeSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  }, 10_000);

  /**
   * `createEnhanceRunner` is shared by `capture` and `enhance`, so which of
   * DEFAULT_CONFIG.enhancement.timeoutMs / standaloneTimeoutMs applies is entirely down to
   * which constant each command's call site passes in — see the comment above
   * createEnhanceRunner. These construct the runner directly in-process the same way each
   * command does, then enhanceNow invokes the executable agent stub in a subprocess. They spy
   * on the global setTimeout that XState's running-state `after` schedules with the resolved
   * bound, to catch the two constants ever being swapped between call sites. The agent stub
   * resolves fast, so the real 4/10-minute timer this schedules is cleared long before it fires.
   */
  describe("createEnhanceRunner timeout wiring", () => {
    async function scratchNote(): Promise<{ vault: string; note: string }> {
      const vault = await mkdtemp(join(tmpdir(), ".cli-timeout-wiring-test-"));
      scratchDirectories.push(vault);
      const note = join(vault, "meeting.md");
      await writeFile(
        note,
        "<!-- shorthand:notes -->\n- mine\n<!-- shorthand:ai:start -->\n## Summary\nOld\n<!-- shorthand:ai:end -->",
        "utf8",
      );
      return { vault, note };
    }

    test("capture's default timeoutMs is the live per-pass bound, not the standalone one", async () => {
      const { vault, note } = await scratchNote();
      const agentStub = join(process.cwd(), "test", "fixtures", "fake-agent.mjs");
      const setTimeoutSpy = spyOn(globalThis, "setTimeout");
      try {
        const resolved = await createEnhanceRunner(
          note, vault, "markdown", ["--agent-stub", agentStub], {}, false,
          DEFAULT_CONFIG.enhancement.timeoutMs,
        );
        if (!resolved.ok) throw new Error(resolved.message);
        expect((await resolved.runner.enhanceNow("tick")).status).toBe("completed");
        const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
        expect(delays).toContain(DEFAULT_CONFIG.enhancement.timeoutMs);
        expect(delays).not.toContain(DEFAULT_CONFIG.enhancement.standaloneTimeoutMs);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    }, 10_000);

    test("enhance's default timeoutMs is the standalone bound, not the live one", async () => {
      const { vault, note } = await scratchNote();
      const agentStub = join(process.cwd(), "test", "fixtures", "fake-agent.mjs");
      const setTimeoutSpy = spyOn(globalThis, "setTimeout");
      try {
        const resolved = await createEnhanceRunner(
          note, vault, "markdown", ["--agent-stub", agentStub], {}, false,
          DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
        );
        if (!resolved.ok) throw new Error(resolved.message);
        expect((await resolved.runner.enhanceNow("tick")).status).toBe("completed");
        const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
        expect(delays).toContain(DEFAULT_CONFIG.enhancement.standaloneTimeoutMs);
        expect(delays).not.toContain(DEFAULT_CONFIG.enhancement.timeoutMs);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    }, 10_000);

    test("HANDY_NOTES_AGENT_TIMEOUT_MS overrides whichever default createEnhanceRunner was given", async () => {
      const { vault, note } = await scratchNote();
      const agentStub = join(process.cwd(), "test", "fixtures", "fake-agent.mjs");
      const setTimeoutSpy = spyOn(globalThis, "setTimeout");
      try {
        const resolved = await createEnhanceRunner(
          note, vault, "markdown", ["--agent-stub", agentStub],
          { HANDY_NOTES_AGENT_TIMEOUT_MS: "7000" }, false,
          DEFAULT_CONFIG.enhancement.timeoutMs,
        );
        if (!resolved.ok) throw new Error(resolved.message);
        expect((await resolved.runner.enhanceNow("tick")).status).toBe("completed");
        const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
        expect(delays).toContain(7_000);
        expect(delays).not.toContain(DEFAULT_CONFIG.enhancement.timeoutMs);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    }, 10_000);
  });
});

// Strips the two Google OAuth env vars from an arbitrary env object. Exists as its own
// function (rather than inline in run()) so both withoutGoogleOAuthEnv() (an explicit,
// caller-side "start from a clean process.env" helper) and run() itself (an unconditional,
// structural guard applied to whatever env it's handed) share one implementation.
function stripGoogleOAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GOOGLE_OAUTH_CLIENT_ID: _id, GOOGLE_OAUTH_CLIENT_SECRET: _secret, ...rest } = env;
  return rest;
}

function withoutGoogleOAuthEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...stripGoogleOAuthEnv(process.env), ...overrides };
}

/** The connectApp most LLM-backend tests want: one that succeeds and is never inspected. */
function connectFake(): () => Promise<AppClientLike> {
  return async () => new FakeAppClient();
}

/**
 * Drives one request through the `fetch` the last-built LLM backend was given, and reports
 * the credential slot it arrived at the app under.
 *
 * The wait is a loop rather than a fixed number of turns because `createAppFetch` reads the
 * whole request body before it sends, and how many turns that takes is the `Request`
 * implementation's business, not this test's. The fake never answers, so the returned
 * promise stays pending on purpose — the assertion is about the request, not the response.
 */
async function slotOfNextFetch(client: FakeAppClient, url: string): Promise<unknown> {
  const appFetch = providerCalls.at(-1)?.fetch as typeof globalThis.fetch;
  void appFetch(url, { method: "POST", body: "{}" });
  for (let attempt = 0; attempt < 50 && client.lastSent("http.fetch") === undefined; attempt += 1) {
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
  }
  return client.lastSent("http.fetch")?.params.slot;
}

// Points every environment variable shorthandConfigDirectory() consults at a scratch
// directory, the same way withoutGoogleOAuthEnv's Google-credentials callers already do, so
// requestSocketDiscoveryPath() resolves inside it on every platform and a test never reads
// the real per-user config directory.
function redirectConfigDirectory(configDirectory: string): NodeJS.ProcessEnv {
  return withoutGoogleOAuthEnv({
    APPDATA: configDirectory, XDG_CONFIG_HOME: configDirectory, HOME: configDirectory, USERPROFILE: configDirectory,
  });
}

/**
 * A server that answers the request socket with a hello line and then nothing else, plus the
 * discovery file pointing at it — the minimum for a subprocess CLI to get past
 * `ShorthandAppClient.connect`.
 *
 * A named pipe on Windows and a filesystem socket elsewhere, because that is the split the
 * wire contract specifies and `connect()` inherits it from the discovery file either way.
 */
async function startStandInApp(
  configDirectory: string,
): Promise<Readonly<{ environment: NodeJS.ProcessEnv; close: () => Promise<void> }>> {
  const environment = redirectConfigDirectory(configDirectory);
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\shorthand-cli-test-${process.pid}-${Date.now()}`
    : join(configDirectory, "request.sock");
  const server: Server = createServer((socket) => {
    socket.write(`${JSON.stringify({ t: "hello", protocol: 1, version: "0.5.0", capabilities: ["credential", "http-fetch", "ws-relay"] })}\n`);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(address, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const discovery = requestSocketDiscoveryPath(environment);
  await mkdir(dirname(discovery), { recursive: true });
  await writeFile(discovery, JSON.stringify({ protocol: 1, path: address }), "utf8");
  return {
    environment,
    close: () => new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    }),
  };
}

function run(
  entry: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    // Unconditional, structural guard: whatever `env` this call received — the
    // process's own inherited environment by default, or an explicit object a caller
    // built — GOOGLE_OAUTH_CLIENT_ID/SECRET never reach spawn() from here. Callers that
    // already pass withoutGoogleOAuthEnv(...) explicitly are stripped twice, which is a
    // no-op; this is defense-in-depth, not a replacement for that caller-side clarity.
    const spawnOptions: any = { stdio: ["ignore", "pipe", "pipe"], env: stripGoogleOAuthEnv(env) };
    if (cwd !== undefined) {
      spawnOptions.cwd = cwd;
    }
    const child = spawn(process.execPath, ["--no-env-file", entry, ...args], spawnOptions);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

// Like run(), but for a command whose OWN retries (the AI SDK wraps a failed call in its
// own backoff, on top of the contract's retry) would otherwise stretch the subprocess's
// lifetime well past what the test needs. Resolves with whatever stderr has accumulated the
// moment it contains `needle`, and kills the child rather than waiting for it to exit — the
// assertion this exists for only needs a status line the runner emits before it ever makes
// the network call the retries are wrapping.
function runUntilStderrContains(
  entry: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  needle: string,
  timeoutMs = 8_000,
): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const spawnOptions: any = { stdio: ["ignore", "pipe", "pipe"], env: stripGoogleOAuthEnv(env) };
    const child = spawn(process.execPath, ["--no-env-file", entry, ...args], spawnOptions);
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectRun(new Error(`Timed out waiting for stderr to contain ${JSON.stringify(needle)}. stderr so far:\n${stderr}`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (settled || !stderr.includes(needle)) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolveRun(stderr);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(stderr);
    });
  });
}
