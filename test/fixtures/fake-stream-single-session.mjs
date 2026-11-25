#!/usr/bin/env node
// One recording, then the stream stays open the way the real app's does between
// recordings. `--exit-after-session` is what lets capture end on this stream.
// fake-stream-idle.mjs is the variant with no recording in progress.

const idle = false;
const lines = idle
  ? [
      '{"t":"hello","protocol":1,"version":"0.9.5","emitted_at":"2026-08-15T14:03:20.100-07:00"}',
      '{"t":"capture_state","phase":"idle","emitted_at":"2026-08-15T14:03:20.150-07:00"}',
    ]
  : [
      '{"t":"hello","protocol":1,"version":"0.9.5","emitted_at":"2026-08-15T14:03:20.100-07:00"}',
      '{"t":"capture_state","phase":"recording","mode":"meeting","publishing":true,"session":7,"emitted_at":"2026-08-15T14:03:20.150-07:00"}',
      '{"t":"begin","session":7,"streaming":true,"emitted_at":"2026-08-15T14:03:20.200-07:00","session_elapsed_ms":0}',
      '{"t":"partial","session":7,"speaker":"me","committed":"Kickoff notes ","tentative":"","emitted_at":"2026-08-15T14:03:21.412-07:00","session_elapsed_ms":1212}',
      '{"t":"final","session":7,"speaker":"me","text":"Kickoff notes.","emitted_at":"2026-08-15T14:03:22.050-07:00","session_elapsed_ms":1850}',
    ];

for (const line of lines) {
  process.stdout.write(`${line}\n`);
  await new Promise((resolve) => setTimeout(resolve, 35));
}
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
