import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const script = fileURLToPath(new URL("./fixtures/foreign-realm-claude.ts", import.meta.url));
const executable = fileURLToPath(new URL("./fixtures/exit-before-handshake.mjs", import.meta.url));

// Obsidian's renderer pairs a browser AbortController with Node's `events`, and the SDK passes
// its own signals to Node's setMaxListeners inside query(). Unguarded, both calls below throw
// ERR_INVALID_ARG_TYPE before anything is spawned, so the plugin reports "couldn't reach
// Claude" for every user. Reaching the executable's own exit proves the SDK got past that.
test("both Claude SDK paths reach the executable under a foreign-realm AbortController", () => {
  const run = spawnSync(process.execPath, [script, executable], { encoding: "utf8", timeout: 60_000 });
  expect(run.status).toBe(0);
  const outcome = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
  expect(outcome).toEqual({
    catalog: {
      message: "Failed to fetch the Claude model catalog: Claude Code process exited with code 1",
      reason: "spawn-failed",
    },
    query: { message: "Claude Code process exited with code 1" },
    globalRestored: true,
  });
});
