import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFinalEnhancementWithRetries } from "../bin/handy-notes.js";
import type { PassOutcome } from "../src/agent/runner.js";

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("handy-notes CLI", () => {
  test("final enhancement retries requeued and timed-out outcomes with backoff", async () => {
    const outcomes: PassOutcome[] = [
      { status: "requeued", reason: "note-locked" },
      { status: "timed-out" },
      { status: "completed", tier: "link", sections: [], costUsd: 0, written: true },
    ];
    const delays: number[] = [];
    const outcome = await runFinalEnhancementWithRetries(
      { enhanceNow: async () => outcomes.shift()! },
      async (milliseconds) => { delays.push(milliseconds); },
    );
    expect(outcome.status).toBe("completed");
    expect(delays).toEqual([200, 500]);
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
    const vault = await mkdtemp(join(process.cwd(), ".cli-enhance-stub-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const transcript = join(vault, "transcript.md");
    const original = "<!-- handy:notes -->\n- mine\n<!-- handy:ai:start -->\n## Summary\nOld\n<!-- handy:ai:end -->";
    await writeFile(note, original, "utf8");
    await writeFile(transcript, "me: offline transcript", "utf8");
    const result = await run(join(process.cwd(), "bin", "handy-notes.ts"), [
      "enhance", "--vault", vault, "--note", "meeting.md", "--transcript", "transcript.md",
      "--tier", "tick", "--dry-run", "--agent-stub", join(process.cwd(), "test", "fixtures", "fake-agent.mjs"),
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ heading: "Stub summary", markdown: "Offline result" }]);
    expect(await readFile(note, "utf8")).toBe(original);
  });

  test("capture --enhance keeps capturing and runs the final link pass through the offline stub", async () => {
    const vault = await mkdtemp(join(process.cwd(), ".cli-capture-enhance-test-"));
    scratchDirectories.push(vault);
    const entry = join(process.cwd(), "bin", "handy-notes.ts");
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
    expect(await readFile(join(vault, "transcript.md"), "utf8")).toContain("# Handy Transcript");
    expect(await readFile(join(vault, "meeting.md"), "utf8")).toContain("## Stub summary\nOffline result");
  }, 10_000);

  test("runs capture with an explicit fake stream and links a pre-existing note without changing its content", async () => {
    const vault = await mkdtemp(join(process.cwd(), ".cli-smoke-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const sidecar = join(vault, "transcript.md");
    const originalNote = "# Meeting\n\nUser-owned notes.\n";
    await writeFile(note, originalNote, "utf8");
    const entry = join(process.cwd(), "bin", "handy-notes.ts");
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
    expect(linkedNote).toStartWith('---\nhandy-transcript: "[[transcript]]"\n---\n');
    expect(linkedNote.slice(linkedNote.indexOf(originalNote))).toBe(originalNote);
    expect(await readFile(sidecar, "utf8")).toContain("# Handy Transcript");
  }, 10_000);

  test("init-note creates a linked scaffold without overwriting an existing note", async () => {
    const vault = await mkdtemp(join(process.cwd(), ".cli-init-test-"));
    scratchDirectories.push(vault);
    const entry = join(process.cwd(), "bin", "handy-notes.ts");
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
    expect(content).toContain('handy-transcript: "[[Meetings/Transcripts/standup]]"');
    expect(content).toContain("# Weekly Standup\n\n<!-- handy:notes -->");
    expect(content).toContain("<!-- handy:ai:start -->\n## Summary");
    const second = await run(entry, args);
    expect(second.code).toBe(1);
    expect(await readFile(note, "utf8")).toBe(content);
  });

  test("set-sections writes through the block writer and preserves user bytes", async () => {
    const vault = await mkdtemp(join(process.cwd(), ".cli-set-sections-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const json = join(vault, "sections.json");
    const original = "user\tbytes  \r\n<!-- handy:ai:start -->\r\n## Old\r\n<!-- handy:ai:end -->tail";
    await writeFile(note, original, "utf8");
    await writeFile(json, JSON.stringify([{ heading: "Summary", markdown: "Done" }]), "utf8");
    const entry = join(process.cwd(), "bin", "handy-notes.ts");
    const result = await run(entry, ["set-sections", "--note", note, "--json", json, "--force"]);
    expect(result.code).toBe(0);
    expect(await readFile(note, "utf8")).toBe(
      "user\tbytes  \r\n<!-- handy:ai:start -->\r\n## Summary\r\nDone\r\n<!-- handy:ai:end -->tail",
    );
  });

  test("read-block supplies a hash and set-sections rejects a stale expected hash without writing", async () => {
    const vault = await mkdtemp(join(process.cwd(), ".cli-stale-hash-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const json = join(vault, "sections.json");
    const original = "before\n<!-- handy:ai:start -->\n## Old\n<!-- handy:ai:end -->\nafter";
    await writeFile(note, original, "utf8");
    await writeFile(json, JSON.stringify([{ heading: "Summary", markdown: "New" }]), "utf8");
    const entry = join(process.cwd(), "bin", "handy-notes.ts");

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
    const vault = await mkdtemp(join(process.cwd(), ".cli-force-gate-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const json = join(vault, "sections.json");
    const original = "<!-- handy:ai:start -->\n<!-- handy:ai:end -->";
    await writeFile(note, original, "utf8");
    await writeFile(json, "[]", "utf8");
    const entry = join(process.cwd(), "bin", "handy-notes.ts");
    const result = await run(entry, ["set-sections", "--note", note, "--json", json]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires --expect-hash");
    expect(await readFile(note, "utf8")).toBe(original);
  });

  test("rejects a missing known-flag value instead of silently using a default", async () => {
    const entry = join(process.cwd(), "bin", "handy-notes.ts");
    const result = await run(entry, ["read-block", "--vault", "--note", "meeting.md"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--vault requires a value");
  });

  test("capture inserts only the transcript key in existing frontmatter", async () => {
    const vault = await mkdtemp(join(process.cwd(), ".cli-frontmatter-link-test-"));
    scratchDirectories.push(vault);
    const note = join(vault, "meeting.md");
    const originalBody = "# Meeting\n\nUser text with\ttabs and café.\n";
    await writeFile(note, `---\nowner: human\n---\n${originalBody}`, "utf8");
    const entry = join(process.cwd(), "bin", "handy-notes.ts");
    const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
    const result = await run(entry, [
      "capture", "--vault", vault, "--note", "meeting.md", "--sidecar", "linked/transcript.md",
      "--fake-stream", fixture, "--no-reconnect",
    ]);
    expect(result.code).toBe(0);
    expect(await readFile(note, "utf8")).toBe(
      `---\nowner: human\nhandy-transcript: "[[linked/transcript]]"\n---\n${originalBody}`,
    );
  }, 10_000);

  test("capture follows the scaffold's sidecar link while leaving the meeting note unchanged", async () => {
    const vault = await mkdtemp(join(process.cwd(), ".cli-linked-capture-test-"));
    scratchDirectories.push(vault);
    const entry = join(process.cwd(), "bin", "handy-notes.ts");
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
    expect(await readFile(join(vault, "linked", "transcript.md"), "utf8")).toContain("# Handy Transcript");
  }, 10_000);
});

function run(entry: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}
