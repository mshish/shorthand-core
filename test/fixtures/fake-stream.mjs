#!/usr/bin/env node

const singleSpeaker = [
  '{"t":"hello","protocol":1,"version":"0.9.5","emitted_at":"2026-08-15T14:03:20.100-07:00"}',
  '{"t":"begin","session":1,"streaming":true,"emitted_at":"2026-08-15T14:03:20.200-07:00","session_elapsed_ms":0}',
  '{"t":"partial","session":1,"speaker":"me","committed":"hello ","tentative":"wor","emitted_at":"2026-08-15T14:03:21.412-07:00","session_elapsed_ms":1212}',
  '{"t":"final","session":1,"speaker":"me","text":"Hello world.","emitted_at":"2026-08-15T14:03:22.050-07:00","session_elapsed_ms":1850}',
  '{"t":"no_speech","session":1,"emitted_at":"...","session_elapsed_ms":700}',
  '{"t":"cancel","session":1,"emitted_at":"...","session_elapsed_ms":700}',
  '{"t":"error","session":1,"message":"transcription failed","emitted_at":"...","session_elapsed_ms":900}',
];

const dualSpeaker = [
  '{"t":"hello","protocol":1,"version":"0.9.5","emitted_at":"2026-08-15T14:03:20.100-07:00"}',
  '{"t":"begin","session":42,"streaming":true,"emitted_at":"2026-08-15T14:03:20.200-07:00","session_elapsed_ms":0}',
  '{"t":"partial","session":42,"speaker":"me","committed":"Can you hear me?","tentative":"","emitted_at":"2026-08-15T14:03:21.412-07:00","session_elapsed_ms":1212}',
  '{"t":"partial","session":42,"speaker":"them","committed":"Yes, clearly.","tentative":"","emitted_at":"2026-08-15T14:03:22.900-07:00","session_elapsed_ms":2700}',
  '{"t":"final","session":42,"text":"Me: Can you hear me?\\nThem: Yes, clearly.","emitted_at":"2026-08-15T14:03:23.010-07:00","session_elapsed_ms":2810}',
];

for (const line of [...singleSpeaker, ...dualSpeaker]) {
  process.stdout.write(`${line}\n`);
  await new Promise((resolve) => setTimeout(resolve, 35));
}
