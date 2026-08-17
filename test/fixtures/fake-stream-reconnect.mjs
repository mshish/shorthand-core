#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const statePath = process.env.SHORTHAND_FAKE_STATE;
if (!statePath) {
  process.stderr.write("SHORTHAND_FAKE_STATE is required\n");
  process.exitCode = 1;
} else {
  let generation = 0;
  try {
    generation = Number.parseInt(await readFile(statePath, "utf8"), 10);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(statePath, String(generation + 1), "utf8");

  if (generation === 0) {
    process.stdout.write('{"t":"hello","protocol":1,"version":"fixture"}\n');
    process.stdout.write('{"t":"begin","session":1,"streaming":true,"session_elapsed_ms":0}\n');
    process.stdout.write('{"t":"partial","session":1,"speaker":"me","committed":"before gap","tentative":"","session_elapsed_ms":100}\n');
    process.stderr.write("fixture disconnect\n");
    process.exitCode = 1;
  } else {
    process.stdout.write('{"t":"hello","protocol":1,"version":"fixture"}\n');
    process.stdout.write('{"t":"begin","session":1,"streaming":true,"session_elapsed_ms":0}\n');
    process.stdout.write('{"t":"partial","session":1,"speaker":"them","committed":"after gap","tentative":"","session_elapsed_ms":100}\n');
    process.stdout.write('{"t":"final","session":1,"speaker":"them","text":"After gap.","session_elapsed_ms":200}\n');
    setInterval(() => {}, 1_000);
  }
}
