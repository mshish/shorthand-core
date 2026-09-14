import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * Resolve the Shorthand binary without baking in a machine-specific path.
 *
 * Order: explicit override -> SHORTHAND_BIN -> PATH -> conventional install and build
 * locations. Falls back to the bare command name so spawn still surfaces a clear ENOENT
 * (the CLI and plugin both report the resolved path when that happens).
 *
 * `fileExists` is injectable for the same reason `environment` is. The conventional
 * locations are absolute paths that exist on any machine where Shorthand is installed —
 * including the machine this library is developed on — so an empty PATH alone cannot
 * reach the not-found fallback, and tests asserting it fail everywhere but a clean CI
 * runner. Stubbing the probe is what makes that branch testable without uninstalling
 * the app.
 */
export function detectShorthandExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const configured = override ?? environment.SHORTHAND_BIN;
  if (configured !== undefined && configured.length > 0) return resolve(configured);

  const windows = process.platform === "win32";
  const names = windows ? ["shorthand.exe", "shorthand"] : ["shorthand"];

  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (fileExists(candidate)) return candidate;
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
    if (fileExists(candidate)) return candidate;
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

/**
 * The file the Shorthand app writes when it starts listening on its request socket, and
 * removes on a clean stop. It lives beside the other Shorthand config files rather than
 * in a runtime directory so both sides can find it with `shorthandConfigDirectory()`
 * alone — there is no second, per-platform runtime-path convention to keep in sync
 * across three repositories and two languages.
 */
export function requestSocketDiscoveryPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(shorthandConfigDirectory(environment), "request-socket.json");
}

/**
 * This package's version, as reported to an ACP agent in `clientInfo`.
 *
 * Declared once because the two call sites that send it each carried their own literal and
 * both were still claiming 0.20.0 two releases later. It is not read from `package.json`:
 * `resolveJsonModule` is off, and enabling it to import the manifest into library code is a
 * larger change than this needs. Bump it together with `package.json` — `test/config.test.ts`
 * reads the manifest and fails if the two ever disagree again.
 */
export const CORE_VERSION = "0.22.1";

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
  // Whole-process shutdown before force-stopping the follow-stream child. This is a
  // different wait than `enhancement.shutdownGraceMs` below — that one bounds a stuck
  // enhancement pass, not the child process — kept as two constants so the two can move
  // independently. See docs/ENHANCEMENT-LIMITS.md.
  shutdownTimeoutMs: 12_000,
  // Effective values, and how these interact with the EnhanceRunner fallbacks they override:
  // docs/ENHANCEMENT-LIMITS.md. Change a number here and that table goes stale.
  thresholds: {
    // Tuned against a real run: ~40s of ordinary speech produced ~130 committed characters,
    // so a 600-char gate meant the first update landed minutes in — the note looked dead.
    // 180 still left a sparser talker — someone typing notes rather than narrating — with a
    // long wait before a first update, so this halves to ~90: roughly one spoken sentence,
    // trading a shorter per-pass budget for passes that start sooner.
    enhancementNewCharacters: 90,
    enhancementIntervalMs: 25_000,
  },
  enhancement: {
    maxDurationMs: 4 * 60 * 60 * 1000, // 4h — a loop breaker, not a product limit
    // Per pass, including the sink read and write as well as both model attempts. Four minutes
    // leaves room for a slow local model while still releasing the live in-flight slot when a
    // provider or document API hangs. The two corrective attempts share this one bound.
    timeoutMs: 240_000,
    // The one-shot `enhance` command gets no retry if its full vault-linked pass times out,
    // so losing that attempt hurts most. A capture's closing pass keeps the live bound but
    // has a retry ladder that can issue the pass twice more after a timeout or requeue.
    standaloneTimeoutMs: 600_000,
    // A loop breaker like maxDurationMs, not a budget: `timeoutMs` is the real per-pass
    // bound. Hitting this ends the query on `error_max_turns`, which carries no
    // structured output, so a capped pass loses its work entirely — the cap has to sit
    // far above any legitimate vault exploration rather than near it.
    maxTurns: 75,
    // How long a forced stop (SIGTERM/SIGHUP, or a second Ctrl+C) waits for an in-flight
    // pass before `runCapture` aborts it via `enhancer.stop()` and skips the closing pass.
    // A first Ctrl+C, or a capture ending without any signal, still waits unbounded — see
    // the comment on `runCapture`'s shutdown path. Deliberately its own constant rather
    // than reusing the top-level `shutdownTimeoutMs`: that one bounds the follow-stream
    // child, an unrelated wait, and coupling them made a signalled shutdown take up to
    // twice `shutdownTimeoutMs` (once per wait) instead of once.
    shutdownGraceMs: 12_000,
  },
});

export type ShorthandConfig = typeof DEFAULT_CONFIG;
