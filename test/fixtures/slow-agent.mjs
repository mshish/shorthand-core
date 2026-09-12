#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";

// Same stub protocol as fake-agent.mjs, plus a one-time delay before answering. The delay
// only fires once (tracked by a marker file, since each pass is a fresh subprocess with no
// shared memory) so a test can hold exactly one pass in flight for longer than
// DEFAULT_CONFIG.enhancement.shutdownGraceMs without the closing pass paying the same delay
// again afterward.
let input = "";
for await (const chunk of process.stdin) input += chunk.toString("utf8");
const request = JSON.parse(input);
if (!Array.isArray(request.tools)) throw new Error("Expected tools in stub request.");

const marker = process.env.SLOW_AGENT_MARKER;
const delayMs = Number(process.env.SLOW_AGENT_DELAY_MS ?? "0");
if (marker !== undefined && !existsSync(marker)) {
  writeFileSync(marker, "");
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

process.stdout.write(JSON.stringify({
  structuredOutput: { sections: [{ heading: "Stub summary", markdown: "Offline result" }] },
}));
