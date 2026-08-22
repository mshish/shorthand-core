import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * Resolve the Shorthand binary without baking in a machine-specific path.
 *
 * Order: explicit override -> SHORTHAND_BIN -> PATH -> conventional install and build
 * locations. Falls back to the bare command name so spawn still surfaces a clear ENOENT
 * (the CLI and plugin both report the resolved path when that happens).
 */
export function detectShorthandExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = override ?? environment.SHORTHAND_BIN;
  if (configured !== undefined && configured.length > 0) return resolve(configured);

  const windows = process.platform === "win32";
  const names = windows ? ["shorthand.exe", "shorthand"] : ["shorthand"];

  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  const home = environment.USERPROFILE ?? environment.HOME ?? homedir();
  const conventional = windows
    ? [
      join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Shorthand", "shorthand.exe"),
      join(environment.PROGRAMFILES ?? "C:\\Program Files", "Shorthand", "shorthand.exe"),
    ]
    : process.platform === "darwin"
      ? ["/Applications/Shorthand.app/Contents/MacOS/shorthand", join(home, "Applications", "Shorthand.app", "Contents", "MacOS", "shorthand")]
      : ["/usr/local/bin/shorthand", "/usr/bin/shorthand", join(home, ".local", "bin", "shorthand")];

  for (const candidate of conventional) {
    if (existsSync(candidate)) return candidate;
  }

  return names[0]!;
}

/**
 * Where Shorthand's own config/credential files live, following the same
 * per-platform conventions detectShorthandExecutable already establishes for
 * finding the binary — so a second, inconsistent convention never gets invented.
 */
export function shorthandConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.USERPROFILE ?? environment.HOME ?? homedir();
  if (process.platform === "win32") {
    return join(environment.APPDATA ?? join(home, "AppData", "Roaming"), "Shorthand");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Shorthand");
  }
  return join(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "shorthand");
}

export const DEFAULT_CONFIG = Object.freeze({
  shorthandBinaryPath: "shorthand",
  followStreamArgs: ["--follow-stream", "json"] as readonly string[],
  sidecarDirectory: join("Meetings", "Transcripts"),
  sidecarFlushIntervalMs: 250,
  templateSections: [
    { heading: "Summary", markdown: "" },
    { heading: "Decisions", markdown: "" },
    { heading: "Action items", markdown: "" },
  ] as const,
  reconnect: {
    maxAttempts: 4,
    backoffMs: [250, 500, 1_000, 2_000] as readonly number[],
  },
  drainTimeoutMs: 10_000,
  shutdownTimeoutMs: 12_000,
  // Effective values, and how these interact with the EnhanceRunner fallbacks they override:
  // docs/ENHANCEMENT-LIMITS.md. Change a number here and that table goes stale.
  thresholds: {
    // Tuned against a real run: ~40s of ordinary speech produced ~130 committed characters,
    // so a 600-char gate meant the first update landed minutes in — the note looked dead.
    // ~180 chars is roughly two spoken sentences, which keeps passes bounded while making
    // the note visibly track the meeting.
    enhancementNewCharacters: 180,
    enhancementIntervalMs: 25_000,
  },
  enhancement: {
    maxDurationMs: 4 * 60 * 60 * 1000, // 4h — a loop breaker, not a product limit
    // Per pass, both attempts: this wraps the whole of queryForSections, including its
    // sequential corrective retry, so each attempt gets whatever budget the other leaves.
    // A pass that outlives it is aborted and its work discarded and requeued. If every pass
    // times out, that requeue repeats forever and the note silently stops updating, so the
    // bound has to clear the slowest legitimate pass rather than sit near typical latency: a
    // local model generating a full section array takes minutes, not the seconds a hosted
    // frontier model needs. Live runners still have to keep up with a meeting in progress, so
    // they stay bounded at 2 minutes rather than growing further.
    timeoutMs: 120_000,
    // The one-shot `enhance` command gets no retry if its full vault-linked pass times out,
    // so losing that attempt hurts most. A capture's closing pass keeps the live bound but
    // has a retry ladder that can issue the pass twice more after a timeout or requeue.
    standaloneTimeoutMs: 300_000,
    // A loop breaker like maxDurationMs, not a budget: `timeoutMs` is the real per-pass
    // bound. Hitting this ends the query on `error_max_turns`, which carries no
    // structured output, so a capped pass loses its work entirely — the cap has to sit
    // far above any legitimate vault exploration rather than near it.
    maxTurns: 75,
  },
});

export type ShorthandConfig = typeof DEFAULT_CONFIG;
