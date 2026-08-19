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
