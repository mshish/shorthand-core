import { tmpdir } from "node:os";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createEnhanceRunner, runCli, runFinalEnhancementWithRetries, selectAgent } from "../bin/shorthand-notes.js";
import { ClaudeAgentClient } from "../src/agent/client.js";
import { CodexAgentClient } from "../src/agent/codex-client.js";
import { LlmAgentClient } from "../src/agent/llm-client.js";
import { llmCredentialsPath } from "../src/agent/llm-credentials.js";
import type { LlmCredentials } from "../src/agent/llm-credentials.js";
import type { PassOutcome } from "../src/agent/runner.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SidecarWriter } from "../src/note/sidecar.js";

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
      const configDirectory = await mkdtemp(join(tmpdir(), ".cli-backend-llm-test-"));
      scratchDirectories.push(configDirectory);
      const environment = await withLlmCredentials(configDirectory, {
        provider: "openai-compatible", model: "local-model", base_url: "http://127.0.0.1:1",
      });
      const args = value === undefined ? [flag] : [flag, value];
      const result = await selectAgent(args, environment);
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(LlmAgentClient);
    });

    test("an unknown --backend value is a usage error, not a runtime one", async () => {
      await expect(selectAgent(["--backend", "bogus"], {})).rejects.toThrow("--backend must be claude, llm, or codex.");
    });

    test("a missing LLM credentials file exits non-zero with the reader's message verbatim", async () => {
      const configDirectory = await mkdtemp(join(tmpdir(), ".cli-backend-missing-creds-test-"));
      scratchDirectories.push(configDirectory);
      const environment = await withLlmCredentials(configDirectory, undefined);
      const result = await selectAgent(["--backend", "llm"], environment);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toBe(`No LLM credentials at ${llmCredentialsPath(environment)}; configure an LLM provider, then retry.`);
    });

    test("a malformed LLM credentials file exits non-zero with the reader's message verbatim", async () => {
      const configDirectory = await mkdtemp(join(tmpdir(), ".cli-backend-bad-creds-test-"));
      scratchDirectories.push(configDirectory);
      const environment = await withLlmCredentials(configDirectory, undefined);
      const path = llmCredentialsPath(environment);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{ not json", "utf8");
      const result = await selectAgent(["--backend", "llm"], environment);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain(`LLM credentials at ${path} are not valid JSON`);
    });

    test("keyless openai-compatible credentials are accepted", async () => {
      const configDirectory = await mkdtemp(join(tmpdir(), ".cli-backend-keyless-test-"));
      scratchDirectories.push(configDirectory);
      const environment = await withLlmCredentials(configDirectory, {
        provider: "openai-compatible", model: "local-model", base_url: "http://127.0.0.1:1",
      });
      const result = await selectAgent(["--backend", "llm"], environment);
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).toBeInstanceOf(LlmAgentClient);
    });

    test("a provider that needs a key but has none surfaces through ok:false, not a thrown exception", async () => {
      // Construction throws inside LlmAgentClient for a keyed provider with no key.
      // selectAgent must catch it and route it through the same ok:false path a
      // credential-read failure takes, so runCli's catch-all (which reformats anything
      // that is not an ArgumentError) never sees it.
      const configDirectory = await mkdtemp(join(tmpdir(), ".cli-backend-nokey-test-"));
      scratchDirectories.push(configDirectory);
      const environment = await withLlmCredentials(configDirectory, { provider: "openai", model: "gpt-4o-mini" });
      const result = await selectAgent(["--backend", "llm"], environment);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain("No API key");
      expect(!result.ok && result.message).toContain(llmCredentialsPath(environment));
    });

    test("rejects --claude combined with --backend llm instead of silently ignoring one", async () => {
      await expect(selectAgent(["--backend", "llm", "--claude", "C:\\fake\\claude.exe"], {}))
        .rejects.toThrow("--claude cannot be combined with --backend llm");
    });

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

    test("--agent-stub wins over --backend, even when the LLM credentials would fail to resolve", async () => {
      const result = await selectAgent(
        ["--backend", "llm", "--agent-stub", join(process.cwd(), "test", "fixtures", "fake-agent.mjs")],
        {},
      );
      if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
      expect(result.agent).not.toBeInstanceOf(LlmAgentClient);
      expect(result.agent).not.toBeInstanceOf(ClaudeAgentClient);
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
      // Port 1 refuses the TCP connection almost immediately (confirmed ~50ms locally), but
      // the AI SDK wraps every call in its own retry loop with backoff, which stacks with the
      // contract's own retry — confirmed empirically to stretch a full failed pass to ~13s.
      // The assertion only needs the tier the runner requested, and that is decided before the
      // network call ever happens (runner.ts:189-191), so runUntilStderrContains below kills
      // the child the moment "started (tick)" appears rather than waiting out those retries.
      const environment = await withLlmCredentials(configDirectory, {
        provider: "openai-compatible", model: "local-model", base_url: "http://127.0.0.1:1",
      });
      const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
      const stderr = await runUntilStderrContains(entry, [
        "capture", "--vault", vault, "--note", "meeting.md", "--fake-stream", fixture,
        "--no-reconnect", "--enhance", "--backend", "llm",
      ], environment, "started (tick)");
      expect(stderr).toContain("started (tick)");
    }, 10_000);
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

// Redirects the config directory the same way withoutGoogleOAuthEnv's Google-credentials
// callers already do (APPDATA/XDG_CONFIG_HOME/HOME/USERPROFILE all pointed at a scratch
// directory), then optionally seeds llm-credentials.json at the path llmCredentialsPath
// resolves under that redirect — so a test can control exactly what selectAgent/readLlmCredentials
// see without touching the real per-user config directory. `credentials === undefined` leaves
// the file absent, for the missing-file case.
async function withLlmCredentials(
  configDirectory: string,
  credentials: LlmCredentials | undefined,
): Promise<NodeJS.ProcessEnv> {
  const environment = withoutGoogleOAuthEnv({
    APPDATA: configDirectory, XDG_CONFIG_HOME: configDirectory, HOME: configDirectory, USERPROFILE: configDirectory,
  });
  if (credentials !== undefined) {
    const path = llmCredentialsPath(environment);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(credentials), "utf8");
  }
  return environment;
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
