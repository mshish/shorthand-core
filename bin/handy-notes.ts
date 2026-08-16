#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ClaudeAgentClient, detectClaudeExecutable, ExecutableAgentStub } from "../src/agent/client.js";
import { EnhanceRunner, type PassOutcome } from "../src/agent/runner.js";
import type { AgentClient, AgentTier } from "../src/agent/contract.js";
import { DEFAULT_CONFIG, detectHandyExecutable } from "../src/config.js";
import { buildNoteScaffold, transcriptWikilink, type Section } from "../src/note/markers.js";
import { MarkdownNoteSink } from "../src/note/markdown-sink.js";
import { SidecarWriter } from "../src/note/sidecar.js";
import { linkTranscriptFrontmatter, readCurrentBlock, writeSections } from "../src/note/writer.js";
import { StreamClient, type ExitDiagnosis } from "../src/stream/client.js";
import { enhancementDelta, TranscriptStore } from "../src/stream/transcript.js";

function usage(message?: string): number {
  if (message !== undefined) console.error(message);
  console.error(
    "Usage:\n  handy-notes capture --note <meeting-note.md> [--vault <path>] [--sidecar <transcript.md>] [--handy <path>] [--fake-stream [script-path]] [--no-reconnect] [--enhance] [--agent-stub <script>] [--claude <path>]\n  handy-notes enhance --note <path> --transcript <path> [--vault <path>] [--tier tick|link] [--dry-run] [--agent-stub <script>] [--claude <path>]\n  handy-notes init-note --vault <path> --note <path> [--title <text>] [--sidecar <path>]\n  handy-notes read-block --note <path> [--vault <path>]\n  handy-notes set-sections --note <path> [--vault <path>] --json <file> (--expect-hash <sha256> | --force)",
  );
  return 2;
}

function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.md`;
}

const KNOWN_FLAGS = new Set([
  "--note", "--vault", "--sidecar", "--handy", "--fake-stream", "--no-reconnect",
  "--title", "--json", "--expect-hash", "--force", "--enhance", "--transcript",
  "--tier", "--dry-run", "--agent-stub", "--claude",
]);

class ArgumentError extends Error {}

function argumentValue(args: readonly string[], flag: string, optionalValue = false): string | undefined {
  const assigned = args.find((argument) => argument.startsWith(`${flag}=`));
  if (assigned !== undefined) {
    const value = assigned.slice(flag.length + 1);
    if (value.length === 0 && !optionalValue) throw new ArgumentError(`${flag} requires a value.`);
    return value.length === 0 ? undefined : value;
  }
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const candidate = args[index + 1];
  const isKnownFlag = candidate !== undefined && [...KNOWN_FLAGS].some((known) => candidate === known || candidate.startsWith(`${known}=`));
  if (candidate === undefined || isKnownFlag) {
    if (optionalValue) return undefined;
    throw new ArgumentError(`${flag} requires a value.`);
  }
  return candidate;
}

function resolveFrom(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "capture") return await runCapture(args, environment);
    if (command === "enhance") return await runEnhance(args, environment);
    if (command === "init-note") return await initializeNote(args);
    if (command === "read-block") return await readBlock(args);
    if (command === "set-sections") return await setSections(args);
    return usage("Expected capture, enhance, init-note, read-block, or set-sections.");
  } catch (error) {
    if (error instanceof ArgumentError) return usage(error.message);
    throw error;
  }
}

async function runCapture(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {

  const noteArg = argumentValue(args, "--note");
  if (noteArg === undefined) return usage("--note is required.");

  const vault = resolve(argumentValue(args, "--vault") ?? process.cwd());
  const note = resolveFrom(vault, noteArg);
  let noteContent: string;
  try {
    noteContent = await readFile(note, "utf8");
  } catch (error) {
    console.error(`Cannot read meeting note ${note}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const sidecarArg = argumentValue(args, "--sidecar");
  const linkedSidecar = transcriptWikilink(noteContent);
  const linkedSidecarFile = linkedSidecar === undefined || /\.md$/i.test(linkedSidecar)
    ? linkedSidecar
    : `${linkedSidecar}.md`;
  const sidecarPath = sidecarArg !== undefined
    ? resolveFrom(vault, sidecarArg)
    : linkedSidecarFile !== undefined
      ? resolveFrom(vault, linkedSidecarFile)
      : join(vault, DEFAULT_CONFIG.sidecarDirectory, timestampName(new Date()));
  if (sidecarArg !== undefined && linkedSidecarFile !== undefined) {
    const linkedPath = resolveFrom(vault, linkedSidecarFile);
    if (!pathsEqual(linkedPath, sidecarPath)) {
      console.error(`--sidecar does not match the meeting note's handy-transcript link (${linkedSidecar}). The meeting note is read-only during capture.`);
      return 1;
    }
  }
  if (pathsEqual(sidecarPath, note)) {
    console.error("--sidecar must not resolve to the read-only --note path.");
    return 1;
  }
  let noteLinked = linkedSidecarFile !== undefined;
  if (!noteLinked) {
    const relativeSidecar = relative(vault, sidecarPath).replaceAll("\\", "/").replace(/\.md$/i, "");
    const linked = await linkTranscriptFrontmatter(note, relativeSidecar);
    if (linked.status === "error") {
      console.error(linked.error.message);
      return 1;
    }
    if (linked.status === "note-locked" || linked.status === "retry") {
      console.error(linked.status === "note-locked"
        ? `Meeting note is locked and could not be linked: ${note}`
        : `Meeting note changed repeatedly while adding the transcript link: ${note}`);
      return 3;
    }
    noteLinked = true;
  }
  const fake = args.some((argument) => argument === "--fake-stream" || argument.startsWith("--fake-stream="));
  const suppliedFixture = fake ? argumentValue(args, "--fake-stream", true) : undefined;
  const bundledFixture = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-stream.mjs");
  const fixture = suppliedFixture === undefined ? bundledFixture : resolveFrom(process.cwd(), suppliedFixture);
  const handyBinary = detectHandyExecutable(argumentValue(args, "--handy"), environment);
  const client = new StreamClient({
    command: fake ? process.execPath : handyBinary,
    args: fake ? [fixture] : DEFAULT_CONFIG.followStreamArgs,
    maxReconnectAttempts: DEFAULT_CONFIG.reconnect.maxAttempts,
    backoffMs: DEFAULT_CONFIG.reconnect.backoffMs,
    reconnectOnExit: !args.includes("--no-reconnect"),
    drainTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
  });
  const transcript = new TranscriptStore();
  const sidecar = new SidecarWriter(sidecarPath, { flushIntervalMs: DEFAULT_CONFIG.sidecarFlushIntervalMs });
  const enhancer = args.includes("--enhance")
    ? createEnhanceRunner(note, vault, args, environment, false)
    : undefined;
  let exitCode = 0;
  let interruptCount = 0;
  let shutdownRequested = false;

  client.on("event", ({ generation, record }) => {
    const update = transcript.ingest(generation, record);
    if (update !== null) sidecar.apply(update);
    if (enhancer !== undefined && update !== null) {
      const delta = enhancementDelta(update);
      if (delta.length > 0) {
        enhancer.appendTranscript(delta);
        enhancer.requestTick();
      }
    }
    if (record.t === "partial") {
      console.log(`[generation ${generation}] partial session=${record.session} speaker=${record.speaker} committed=${record.committed.length}`);
    } else if (record.t === "begin" && !record.streaming) {
      console.error(`[generation ${generation}] session=${record.session} is non-streaming; partial transcript updates will not be available before final.`);
    } else if (record.t !== "hello") {
      console.log(`[generation ${generation}] ${record.t} session=${record.session}`);
    }
  });
  client.on("connectionError", ({ record }) => {
    console.error(`Handy connection error ${record.code}: ${record.message}`);
    exitCode = 1;
  });
  client.on("parseError", ({ error }) => console.error(`Ignored malformed stream record: ${error.message}`));
  client.on("protocolError", ({ error }) => {
    console.error(error.message);
    exitCode = 1;
  });
  client.on("processError", ({ error, command: configuredCommand }) => {
    console.error(`Failed to start Handy follow-stream binary "${configuredCommand}": ${error.message}`);
    exitCode = 1;
  });
  client.on("disconnect", ({ generation, diagnosis }) => {
    for (const update of transcript.markConnectionEnded(generation)) sidecar.apply(update);
    if (!diagnosis.clean) {
      console.error(diagnosis.message);
      if (!shutdownRequested) exitCode = diagnosis.code === 2 ? 2 : 1;
    }
  });
  client.on("reconnect", ({ generation, attempt, delayMs, gap }) => {
    if (gap) sidecar.addReconnectWarning(generation);
    console.error(`Stream disconnected; reconnect ${attempt} in ${delayMs}ms (generation ${generation}).`);
  });
  client.on("drainTimeout", ({ timeoutMs }) => {
    console.error(`Drain timed out after ${timeoutMs}ms; forcing the follow-stream child to stop.`);
    exitCode = 1;
  });
  client.on("giveUp", ({ attempts }) => {
    console.error(`Stream reconnect limit reached after ${attempts} attempts.`);
    exitCode = 1;
  });
  sidecar.on("writeError", ({ error }) => {
    console.error(`Sidecar write failed for ${sidecarPath}: ${error.message}`);
    exitCode = 1;
  });

  const settled = new Promise<ExitDiagnosis>((resolveSettled) => client.once("settled", resolveSettled));
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let armShutdownTimeout = () => {};
  const shutdownTimeout = new Promise<void>((resolveTimeout) => {
    armShutdownTimeout = () => {
      if (shutdownTimer !== undefined) return;
      shutdownTimer = setTimeout(() => {
        console.error(`Shutdown timed out after ${DEFAULT_CONFIG.shutdownTimeoutMs}ms; forcing the child process to stop.`);
        exitCode = 1;
        client.forceStop();
        resolveTimeout();
      }, DEFAULT_CONFIG.shutdownTimeoutMs);
    };
  });
  const gracefulInterrupt = () => {
    shutdownRequested = true;
    armShutdownTimeout();
    interruptCount += 1;
    if (interruptCount === 1) {
      console.error("Stopping after the active session's terminal event; press Ctrl+C again to force.");
      client.stopAfterDrain();
    } else {
      client.forceStop();
    }
  };
  const forcedShutdown = () => {
    shutdownRequested = true;
    armShutdownTimeout();
    client.forceStop();
  };
  const exitGuard = () => client.forceStop();
  process.on("SIGINT", gracefulInterrupt);
  process.on("SIGTERM", forcedShutdown);
  process.on("SIGHUP", forcedShutdown);
  process.on("exit", exitGuard);

  try {
    client.start();
    await Promise.race([settled, shutdownTimeout]);
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
  } finally {
    process.off("SIGINT", gracefulInterrupt);
    process.off("SIGTERM", forcedShutdown);
    process.off("SIGHUP", forcedShutdown);
    await sidecar.close();
  }
  if (enhancer !== undefined) {
    enhancer.stopLiveTicks();
    await enhancer.waitForIdle();
    const finalEnhancement = await runFinalEnhancementWithRetries(enhancer);
    reportPassOutcome(finalEnhancement);
    if (finalEnhancement.status !== "completed" && finalEnhancement.status !== "not-ready") exitCode = 1;
  }
  console.log(`${linkedSidecarFile === undefined && noteLinked ? "Meeting note linked" : "Meeting note left unchanged"}: ${note}`);
  console.log(`Sidecar written: ${sidecarPath}`);
  return exitCode;
}

async function runEnhance(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const noteArg = argumentValue(args, "--note");
  const transcriptArg = argumentValue(args, "--transcript");
  if (noteArg === undefined || transcriptArg === undefined) return usage("enhance requires --note and --transcript.");
  const tierArg = argumentValue(args, "--tier") ?? "link";
  if (tierArg !== "tick" && tierArg !== "link") return usage("--tier must be tick or link.");
  const tier: AgentTier = tierArg;
  const vault = resolve(argumentValue(args, "--vault") ?? process.cwd());
  const note = resolveFrom(vault, noteArg);
  const transcriptPath = resolveFrom(vault, transcriptArg);
  let transcriptText: string;
  try {
    transcriptText = await readFile(transcriptPath, "utf8");
  } catch (error) {
    console.error(`Cannot read transcript ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const dryRun = args.includes("--dry-run");
  const runner = createEnhanceRunner(note, vault, args, environment, dryRun);
  runner.appendTranscript(transcriptText);
  const outcome = await runner.enhanceNow(tier);
  if (outcome.status === "completed") {
    if (dryRun) console.log(JSON.stringify(outcome.sections, null, 2));
    else console.log(`AI sections ${outcome.written ? "written" : "unchanged"}: ${note}`);
    return 0;
  }
  reportPassOutcome(outcome);
  return outcome.status === "requeued" ? 3 : 1;
}

function createEnhanceRunner(
  note: string,
  vault: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  dryRun: boolean,
): EnhanceRunner {
  const stubPath = argumentValue(args, "--agent-stub") ?? environment.HANDY_NOTES_AGENT_STUB;
  const agent: AgentClient = stubPath === undefined
    ? new ClaudeAgentClient()
    : new ExecutableAgentStub(resolveFrom(process.cwd(), stubPath));
  const claudeOverride = argumentValue(args, "--claude");
  const claudeExecutable = detectClaudeExecutable(claudeOverride, environment);
  return new EnhanceRunner({
    sink: new MarkdownNoteSink({ notePath: note, vaultRoot: vault }),
    agent,
    minNewChars: DEFAULT_CONFIG.thresholds.enhancementNewCharacters,
    minIntervalMs: DEFAULT_CONFIG.thresholds.enhancementIntervalMs,
    maxPasses: environmentNumber(environment.HANDY_NOTES_MAX_PASSES, DEFAULT_CONFIG.enhancement.maxPasses),
    maxUsd: environmentNumber(environment.HANDY_NOTES_MAX_USD, DEFAULT_CONFIG.enhancement.maxUsd),
    maxPassUsd: environmentNumber(environment.HANDY_NOTES_MAX_PASS_USD, DEFAULT_CONFIG.enhancement.maxPassUsd),
    timeoutMs: environmentNumber(environment.HANDY_NOTES_AGENT_TIMEOUT_MS, DEFAULT_CONFIG.enhancement.timeoutMs),
    maxTurns: DEFAULT_CONFIG.enhancement.maxTurns,
    dryRun,
    ...(claudeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: claudeExecutable }),
    onStatus: ({ message }) => console.error(message),
  });
}

function reportPassOutcome(outcome: PassOutcome): void {
  if (outcome.status === "completed") return;
  if (outcome.status === "not-ready") console.error(`Enhancement did not run: ${outcome.reason} threshold not met.`);
  else if (outcome.status === "in-flight") console.error("Enhancement did not run because another pass is in flight.");
  else if (outcome.status === "budget-exhausted") console.error(`Enhancement ${outcome.reason} budget is exhausted; capture continues.`);
  else if (outcome.status === "timed-out") console.error("Enhancement timed out and was re-queued.");
  else if (outcome.status === "requeued") console.error(`Enhancement was re-queued (${outcome.reason}).`);
  else if (outcome.status === "skipped") console.error(outcome.reason === "invalid-output"
    ? "Enhancement output was invalid; the existing sections were kept and transcript was re-queued."
    : "Enhancement agent failed; the existing sections were kept and transcript was re-queued.");
  else console.error(`Enhancement failed: ${outcome.error}`);
}

export async function runFinalEnhancementWithRetries(
  runner: Pick<EnhanceRunner, "enhanceNow">,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
): Promise<PassOutcome> {
  const backoffMs = [200, 500];
  let outcome = await runner.enhanceNow("link");
  for (const defaultDelayMs of backoffMs) {
    if (outcome.status !== "requeued" && outcome.status !== "timed-out") return outcome;
    // A target that named its own backoff (a held lock, a `429` Retry-After) knows
    // better than a fixed ladder; the ladder is only the fallback.
    const requested = outcome.status === "requeued" ? outcome.retryAfterMs : undefined;
    await sleep(requested ?? defaultDelayMs);
    outcome = await runner.enhanceNow("link");
  }
  return outcome;
}

function environmentNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function initializeNote(args: readonly string[]): Promise<number> {
  const vaultArg = argumentValue(args, "--vault");
  const noteArg = argumentValue(args, "--note");
  if (vaultArg === undefined || noteArg === undefined) return usage("init-note requires --vault and --note.");
  const vault = resolve(vaultArg);
  const note = resolveFrom(vault, noteArg);
  const now = new Date();
  const sidecar = resolveFrom(vault, argumentValue(args, "--sidecar") ?? join(DEFAULT_CONFIG.sidecarDirectory, timestampName(now)));
  if (pathsEqual(note, sidecar)) {
    console.error("--sidecar must not resolve to the meeting note path.");
    return 1;
  }
  const relativeSidecar = relative(vault, sidecar).replaceAll("\\", "/").replace(/\.md$/i, "");
  const defaultTitle = basename(note, extname(note));
  const scaffold = buildNoteScaffold({
    captureTimestamp: localIsoTimestamp(now),
    transcriptWikilink: relativeSidecar,
    title: argumentValue(args, "--title") ?? defaultTitle,
    sections: DEFAULT_CONFIG.templateSections,
  });
  if (!scaffold.ok) {
    console.error(scaffold.error.message);
    return 1;
  }
  try {
    await mkdir(dirname(note), { recursive: true });
    await writeFile(note, scaffold.value, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    console.error(`Cannot create meeting note ${note}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log(`Meeting note initialized: ${note}`);
  console.log(`Transcript link: ${sidecar}`);
  return 0;
}

async function readBlock(args: readonly string[]): Promise<number> {
  const noteArg = argumentValue(args, "--note");
  if (noteArg === undefined) return usage("read-block requires --note.");
  const vault = resolve(argumentValue(args, "--vault") ?? process.cwd());
  const note = resolveFrom(vault, noteArg);
  const result = await readCurrentBlock(note);
  if (!result.ok) {
    console.error(result.error.message);
    return 1;
  }
  console.log(JSON.stringify({ body: result.value.body, sha256: result.value.hash }));
  return 0;
}

async function setSections(args: readonly string[]): Promise<number> {
  const noteArg = argumentValue(args, "--note");
  const jsonArg = argumentValue(args, "--json");
  if (noteArg === undefined || jsonArg === undefined) return usage("set-sections requires --note and --json.");
  const expectedHash = argumentValue(args, "--expect-hash");
  const force = args.includes("--force");
  if (expectedHash === undefined && !force) return usage("set-sections requires --expect-hash <sha256>; use --force for an unconditional read-now-write-now update.");
  if (expectedHash !== undefined && force) return usage("Use either --expect-hash or --force, not both.");
  if (expectedHash !== undefined && !/^[a-f\d]{64}$/i.test(expectedHash)) return usage("--expect-hash must be a 64-character sha256 value.");
  const vault = resolve(argumentValue(args, "--vault") ?? process.cwd());
  const note = resolveFrom(vault, noteArg);
  let sections: readonly Section[];
  try {
    const candidate: unknown = JSON.parse(await readFile(resolve(jsonArg), "utf8"));
    if (!Array.isArray(candidate) || !candidate.every((item): item is Section => (
      typeof item === "object" && item !== null
      && typeof (item as Record<string, unknown>).heading === "string"
      && typeof (item as Record<string, unknown>).markdown === "string"
    ))) throw new Error("JSON must be an array of {heading, markdown} string objects.");
    sections = candidate;
  } catch (error) {
    console.error(`Cannot read sections JSON: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let writeHash = expectedHash?.toLowerCase();
  if (writeHash === undefined) {
    const observed = await readCurrentBlock(note);
    if (!observed.ok) {
      console.error(observed.error.message);
      return 1;
    }
    writeHash = observed.value.hash;
  }
  const result = await writeSections(note, sections, writeHash);
  if (result.status === "error") {
    console.error(result.error.message);
    return 1;
  }
  if (result.status === "stale") {
    console.error("The AI block changed before it could be written; retry set-sections.");
    return 3;
  }
  if (result.status === "retry") {
    console.error(`The note could not be updated safely (${result.reason}); retry set-sections.`);
    return 3;
  }
  if (result.status === "note-locked") {
    console.error(`The note remained locked after ${result.attempts} rename attempts; retry set-sections.`);
    return 3;
  }
  console.log(result.status === "written" ? `AI sections written: ${note}` : `AI sections unchanged: ${note}`);
  return 0;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function localIsoTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
