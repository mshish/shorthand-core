import { join } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  handyBinaryPath: "handy",
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

export type HandyNotesConfig = typeof DEFAULT_CONFIG;
