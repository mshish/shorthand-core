import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFinalEnhancementWithRetries } from "../bin/shorthand-notes.js";
import type { PassOutcome } from "../src/agent/runner.js";

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

  // google-login performs a real loopback + PKCE + Picker consent round-trip that needs a
  // human in a real browser, so only its argument validation is exercised here — nothing
  // past that point can run in an automated suite without a live network/browser.
  test("google-login requires a client id and secret from flags or environment", async () => {
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const result = await run(entry, ["google-login"], withoutGoogleOAuthEnv());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("google-login requires --client-id/--client-secret");
  });

  test("google-login requires a client secret even when a client id is supplied", async () => {
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const result = await run(entry, ["google-login", "--client-id", "id"], withoutGoogleOAuthEnv());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("google-login requires --client-id/--client-secret");
  });

  test("google-login requires a client id even when a client secret is supplied", async () => {
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const result = await run(entry, ["google-login", "--client-secret", "secret"], withoutGoogleOAuthEnv());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("google-login requires --client-id/--client-secret");
  });

  test("--no-env-file prevents .env file leaks to subprocesses", async () => {
    // Regression test: ensures that even if a .env file exists in the subprocess's
    // working directory with GOOGLE_OAUTH_CLIENT_ID/SECRET, the --no-env-file flag
    // prevents bun from loading it, so the test's withoutGoogleOAuthEnv() intent is
    // honored and google-login fails fast instead of hanging on listenForRedirect().
    const scratchDir = await mkdtemp(join(tmpdir(), ".cli-env-isolation-test-"));
    scratchDirectories.push(scratchDir);
    await writeFile(
      join(scratchDir, ".env"),
      "GOOGLE_OAUTH_CLIENT_ID=fake-leaked-id\nGOOGLE_OAUTH_CLIENT_SECRET=fake-leaked-secret\n",
      "utf8",
    );
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    // Run from the scratch directory (which contains the fake .env) but with env vars removed.
    // Without --no-env-file, this would load the fake credentials from .env and hang.
    // With --no-env-file, google-login exits fast with code 2 (usage error).
    const result = await run(entry, ["google-login"], withoutGoogleOAuthEnv(), scratchDir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("google-login requires --client-id/--client-secret");
  });

  // A full argument-accepted run (real --client-id/--client-secret) is deliberately not
  // tested here: past validation, google-login opens a real browser via `openInBrowser`
  // and blocks on `listenForRedirect` for a human's consent, which the automated suite
  // must not trigger or wait on.
});

function withoutGoogleOAuthEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { GOOGLE_OAUTH_CLIENT_ID: _id, GOOGLE_OAUTH_CLIENT_SECRET: _secret, ...rest } = process.env;
  return { ...rest, ...overrides };
}

function run(
  entry: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const spawnOptions: any = { stdio: ["ignore", "pipe", "pipe"], env };
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
