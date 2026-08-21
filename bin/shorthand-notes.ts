#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// bin/ is INTERNAL to core, not a consumer of it, so it may reach past the public
// entry point. It does so in exactly one place: `read-block` and `set-sections`
// call `readCurrentBlock`/`writeSections` directly. Consequence to record — those
// two commands are Markdown-block-format-coupled and cannot follow core out of
// this repo without the block writer coming with them.
import { ExecutableAgentStub } from "../src/agent/client.js";
import { readCurrentBlock, writeSections } from "../src/note/writer.js";
import {
  ClaudeAgentClient,
  DEFAULT_CONFIG,
  detectClaudeExecutable,
  detectShorthandExecutable,
  EnhanceRunner,
  LlmAgentClient,
  llmCredentialsPath,
  readLlmCredentials,
  SidecarWriter,
  StreamClient,
  TranscriptStore,
  enhancementDelta,
  type AgentClient,
  type AgentTier,
  type ExitDiagnosis,
  type NoteSink,
  type PassOutcome,
  type Section,
} from "shorthand-core";
import {
  buildNoteScaffold,
  linkTranscriptFrontmatter,
  MarkdownNoteSink,
  transcriptWikilink,
} from "shorthand-core/markdown";

function usage(message?: string): number {
  if (message !== undefined) console.error(message);
  console.error(
    "Usage:\n  shorthand-notes capture --note <meeting-note.md> [--vault <path>] [--sidecar <transcript.md>] [--shorthand <path>] [--fake-stream [script-path]] [--no-reconnect] [--enhance] [--sink markdown|google] [--backend claude|llm] [--agent-stub <script>] [--claude <path>]\n  shorthand-notes enhance --note <path> --transcript <path> [--vault <path>] [--tier tick|link] [--sink markdown|google] [--backend claude|llm] [--dry-run] [--agent-stub <script>] [--claude <path>]\n  shorthand-notes init-note --vault <path> --note <path> [--title <text>] [--sidecar <path>]\n  shorthand-notes read-block --note <path> [--vault <path>]\n  shorthand-notes set-sections --note <path> [--vault <path>] --json <file> (--expect-hash <sha256> | --force)",
  );
  return 2;
}

function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.md`;
}

const KNOWN_FLAGS = new Set([
  "--note", "--vault", "--sidecar", "--shorthand", "--fake-stream", "--no-reconnect",
  "--title", "--json", "--expect-hash", "--force", "--enhance", "--transcript",
  "--tier", "--dry-run", "--agent-stub", "--claude", "--sink", "--backend",
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
      console.error(`--sidecar does not match the meeting note's shorthand-transcript link (${linkedSidecar}). The meeting note is read-only during capture.`);
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
  let enhancer: EnhanceRunner | undefined;
  if (args.includes("--enhance")) {
    const sinkArg = argumentValue(args, "--sink") ?? "markdown";
    if (sinkArg !== "markdown" && sinkArg !== "google") return usage("--sink must be markdown or google.");
    const resolved = await createEnhanceRunner(
      note, vault, sinkArg, args, environment, false, DEFAULT_CONFIG.enhancement.timeoutMs,
    );
    if (!resolved.ok) {
      console.error(resolved.message);
      return 1;
    }
    enhancer = resolved.runner;
  }
  const fake = args.some((argument) => argument === "--fake-stream" || argument.startsWith("--fake-stream="));
  const suppliedFixture = fake ? argumentValue(args, "--fake-stream", true) : undefined;
  const bundledFixture = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-stream.mjs");
  const fixture = suppliedFixture === undefined ? bundledFixture : resolveFrom(process.cwd(), suppliedFixture);
  const handyBinary = detectShorthandExecutable(argumentValue(args, "--shorthand"), environment);
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
    console.error(`Shorthand connection error ${record.code}: ${record.message}`);
    exitCode = 1;
  });
  client.on("parseError", ({ error }) => console.error(`Ignored malformed stream record: ${error.message}`));
  client.on("protocolError", ({ error }) => {
    console.error(error.message);
    exitCode = 1;
  });
  client.on("processError", ({ error, command: configuredCommand }) => {
    console.error(`Failed to start Shorthand follow-stream binary "${configuredCommand}": ${error.message}`);
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
  const sinkArg = argumentValue(args, "--sink") ?? "markdown";
  if (sinkArg !== "markdown" && sinkArg !== "google") return usage("--sink must be markdown or google.");
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
  const resolved = await createEnhanceRunner(
    note, vault, sinkArg, args, environment, dryRun, DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
  );
  if (!resolved.ok) {
    console.error(resolved.message);
    return 1;
  }
  const runner = resolved.runner;
  runner.appendTranscript(transcriptText);
  const outcome = await runner.enhanceNow(tier);
  if (outcome.status === "completed") {
    if (dryRun) console.log(JSON.stringify(outcome.sections, null, 2));
    else console.log(`AI sections ${outcome.written ? "written" : "unchanged"}: ${resolved.sinkDescribe}`);
    return 0;
  }
  reportPassOutcome(outcome);
  return outcome.status === "requeued" ? 3 : 1;
}

type SelectAgentResult =
  | Readonly<{ ok: true; agent: AgentClient }>
  | Readonly<{ ok: false; message: string }>;

/**
 * The single place backend precedence is decided, so it cannot drift into three separately
 * maintained checks in runCapture, runEnhance and createEnhanceRunner.
 *
 * Order: `--agent-stub` wins over everything — it exists to make the Claude and LLM
 * backends unreachable in tests, and the e2e smoke test depends on that. Otherwise
 * `--backend` selects, defaulting to `claude`. `--claude` combined with `--backend llm`
 * is rejected rather than ignored: a user who passes both has a wrong mental model of what
 * `--backend` does, and silently honouring `--claude` would teach them it worked.
 *
 * Exported for testing (see runFinalEnhancementWithRetries below for the same reason).
 */
export async function selectAgent(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<SelectAgentResult> {
  const stubPath = argumentValue(args, "--agent-stub") ?? environment.HANDY_NOTES_AGENT_STUB;
  if (stubPath !== undefined) {
    return { ok: true, agent: new ExecutableAgentStub(resolveFrom(process.cwd(), stubPath)) };
  }
  const backendArg = argumentValue(args, "--backend") ?? "claude";
  if (backendArg !== "claude" && backendArg !== "llm") {
    throw new ArgumentError("--backend must be claude or llm.");
  }
  if (backendArg === "claude") {
    return { ok: true, agent: new ClaudeAgentClient() };
  }
  if (argumentValue(args, "--claude") !== undefined) {
    throw new ArgumentError("--claude cannot be combined with --backend llm; the LLM backend never launches a Claude Code executable.");
  }
  const credentialsPath = llmCredentialsPath(environment);
  const credentialsResult = await readLlmCredentials(credentialsPath);
  if (!credentialsResult.ok) return { ok: false, message: credentialsResult.message };
  try {
    return { ok: true, agent: new LlmAgentClient({ credentials: credentialsResult.value, credentialsPath }) };
  } catch (error) {
    // Construction throws when the profile has no API key for a provider that needs one.
    // Routed through the same ok:false + console.error(message) path a credential-read
    // failure takes, rather than rethrown, so runCli's catch-all (which reformats anything
    // that is not an ArgumentError) does not print a different message for the same
    // underlying user mistake.
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

type CreateEnhanceRunnerResult =
  | Readonly<{ ok: true; runner: EnhanceRunner; sinkDescribe: string }>
  | Readonly<{ ok: false; message: string }>;

// `sink` arrives already validated by the caller (runCapture / runEnhance both check
// --sink and exit 2 via usage() before calling this) so an invalid value is structurally
// unreachable here, rather than merely prevented by convention — see the Fix 4 note in
// the whole-branch review this responds to.
//
// `timeoutMs` arrives as a parameter rather than being resolved in here, because this helper
// is shared by both commands and has no way to tell which one called it. Each caller resolves
// its own default before calling — runCapture passes DEFAULT_CONFIG.enhancement.timeoutMs (a
// live pass bounded by the meeting in progress), runEnhance passes
// DEFAULT_CONFIG.enhancement.standaloneTimeoutMs (the one-shot pass with nothing waiting on
// it) — and HANDY_NOTES_AGENT_TIMEOUT_MS still overrides whichever default was passed in.
//
// Exported for testing (see selectAgent's comment above for the same reason).
export async function createEnhanceRunner(
  note: string,
  vault: string,
  sink: "markdown" | "google",
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  dryRun: boolean,
  timeoutMs: number,
): Promise<CreateEnhanceRunnerResult> {
  let resolvedSink: NoteSink;
  if (sink === "google") {
    // Loaded dynamically, not as a top-level import: src/google/docs-client.ts pulls in
    // googleapis by value, and a static import here would load that for every CLI
    // invocation — init-note, read-block, set-sections, and capture/enhance even with the
    // default --sink markdown — bloating dist/shorthand-notes.mjs from ~700KB to ~32MB.
    const { resolveGoogleDocsSink } = await import("shorthand-core/google");
    const resolved = await resolveGoogleDocsSink(note, environment);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    resolvedSink = resolved.sink;
  } else {
    resolvedSink = new MarkdownNoteSink({ notePath: note, vaultRoot: vault });
  }
  const selected = await selectAgent(args, environment);
  if (!selected.ok) return { ok: false, message: selected.message };
  const agent = selected.agent;
  const claudeOverride = argumentValue(args, "--claude");
  const claudeExecutable = detectClaudeExecutable(claudeOverride, environment);
  return {
    ok: true,
    sinkDescribe: resolvedSink.describe,
    runner: new EnhanceRunner({
      sink: resolvedSink,
      agent,
      minNewChars: DEFAULT_CONFIG.thresholds.enhancementNewCharacters,
      minIntervalMs: DEFAULT_CONFIG.thresholds.enhancementIntervalMs,
      maxDurationMs: environmentNumber(environment.HANDY_NOTES_MAX_DURATION_MS, DEFAULT_CONFIG.enhancement.maxDurationMs),
      timeoutMs: environmentNumber(environment.HANDY_NOTES_AGENT_TIMEOUT_MS, timeoutMs),
      maxTurns: DEFAULT_CONFIG.enhancement.maxTurns,
      dryRun,
      ...(claudeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: claudeExecutable }),
      onStatus: ({ message }) => console.error(message),
    }),
  };
}

function reportPassOutcome(outcome: PassOutcome): void {
  if (outcome.status === "completed") return;
  if (outcome.status === "not-ready") console.error(`Enhancement did not run: ${outcome.reason} threshold not met.`);
  else if (outcome.status === "in-flight") console.error("Enhancement did not run because another pass is in flight.");
  else if (outcome.status === "expired") console.error("Enhancement stopped after the maximum duration; capture continues.");
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
