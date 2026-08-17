#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- shorthand:ai:start -->";
const END = "<!-- shorthand:ai:end -->";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(packageRoot, "dist", "shorthand-notes.mjs");
const fakeStream = join(packageRoot, "test", "fixtures", "fake-stream.mjs");
const agentStub = join(packageRoot, "test", "fixtures", "fake-agent.mjs");
let scratchVault;

try {
  scratchVault = await mkdtemp(join(tmpdir(), "shorthand-notes-e2e-"));
  const noteRelative = join("Meetings", "Smoke.md");
  const sidecarRelative = join("Meetings", "Transcripts", "Smoke transcript.md");
  const notePath = join(scratchVault, noteRelative);

  await runCli([
    "init-note", "--vault", scratchVault, "--note", noteRelative,
    "--title", "Offline smoke", "--sidecar", sidecarRelative,
  ]);
  const initialized = await readFile(notePath, "utf8");
  const before = splitOwnedBlock(initialized);

  await runCli([
    "capture", "--vault", scratchVault, "--note", noteRelative,
    "--fake-stream", fakeStream, "--no-reconnect",
  ]);
  await runCli([
    "enhance", "--vault", scratchVault, "--note", noteRelative,
    "--transcript", sidecarRelative, "--tier", "link", "--agent-stub", agentStub,
  ]);

  // Bare --fake-stream, no path: the only case that exercises the CLI's own
  // default fixture, which it resolves as ../test/fixtures/fake-stream.mjs from
  // the BUNDLE location. dist/ and test/ must therefore stay siblings at runtime,
  // and every other invocation here passes an explicit path, so nothing else in
  // CI would notice that coupling breaking.
  const defaultNoteRelative = join("Meetings", "Default fixture.md");
  const defaultSidecarRelative = join("Meetings", "Transcripts", "Default fixture transcript.md");
  await runCli([
    "init-note", "--vault", scratchVault, "--note", defaultNoteRelative,
    "--title", "Default fixture", "--sidecar", defaultSidecarRelative,
  ]);
  await runCli([
    "capture", "--vault", scratchVault, "--note", defaultNoteRelative,
    "--fake-stream", "--no-reconnect",
  ]);
  const defaultSidecar = await readFile(join(scratchVault, defaultSidecarRelative), "utf8");
  assert(
    defaultSidecar.includes("# Shorthand Transcript"),
    "capture with a bare --fake-stream wrote no transcript; the CLI's bundled fixture path is broken",
  );

  const enhanced = await readFile(notePath, "utf8");
  const after = splitOwnedBlock(enhanced);
  assert(after.body !== before.body, "the AI-owned marker body did not change");
  assert(after.prefix === before.prefix, "bytes before the AI-owned marker body changed");
  assert(after.suffix === before.suffix, "bytes after the AI-owned marker body changed");
  process.stdout.write(`Shorthand e2e smoke passed in ${scratchVault}\n`);
} catch (error) {
  process.stderr.write(`Shorthand e2e smoke failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (scratchVault !== undefined) await rm(scratchVault, { recursive: true, force: true });
}

function splitOwnedBlock(content) {
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  assert(start >= 0 && end > start, "meeting note does not contain one ordered AI marker pair");
  assert(content.indexOf(START, start + START.length) < 0, "meeting note has duplicate start markers");
  assert(content.indexOf(END, end + END.length) < 0, "meeting note has duplicate end markers");
  const bodyStart = start + START.length;
  return {
    prefix: content.slice(0, bodyStart),
    body: content.slice(bodyStart, end),
    suffix: content.slice(end),
  };
}

function runCli(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`CLI exited ${String(code)} for ${args[0]}\n${stderr}${stdout}`));
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
