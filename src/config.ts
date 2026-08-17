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
  thresholds: {
    // Tuned against a real run: ~40s of ordinary speech produced ~130 committed characters,
    // so a 600-char gate meant the first update landed minutes in — the note looked dead.
    // ~180 chars is roughly two spoken sentences, which keeps passes bounded while making
    // the note visibly track the meeting.
    enhancementNewCharacters: 180,
    enhancementIntervalMs: 25_000,
  },
  enhancement: {
    maxPasses: 30,
    maxUsd: 5,
    maxPassUsd: 1,
    timeoutMs: 45_000,
    maxTurns: 6,
  },
});

export type ShorthandConfig = typeof DEFAULT_CONFIG;
