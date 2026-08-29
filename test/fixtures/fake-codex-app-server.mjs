#!/usr/bin/env node
// A fake `codex app-server`: reads newline-delimited JSON-RPC on stdin, replies on stdout.
// argv[2] selects a scenario so one script covers every case
// test/agent-catalog-codex.test.ts needs, instead of one process per behaviour:
//   normal          - real fixture data; answers account/read before model/list resolves, and
//                     interleaves an unsolicited notification, so the client under test must
//                     match strictly on id rather than assume request order.
//   signed-out      - account/read returns { account: null }.
//   error           - model/list returns a JSON-RPC error instead of a result.
//   null-error      - model/list returns { result: ..., error: null } on the SAME response,
//                     reproducing a server that always emits the `error` key rather than
//                     omitting it. Regression case: `parsed.error !== undefined` used to be true
//                     for `null`, so this crashed the handshake instead of resolving it.
//   hang            - never responds to anything past initialize, to exercise the timeout path.
//   paginated       - model/list's fixture data split across two pages via nextCursor.
//   garbage         - model/list writes a line that is not valid JSON at all.
//   missing-data    - model/list's result omits the "data" array entirely.
//   missing-account - account/read's result omits the "account" field entirely.
//   omitted-cursor  - model/list's single-page result has no "nextCursor" key at all (as
//                     opposed to an explicit null), proving the client still terminates
//                     pagination instead of treating `undefined` as "more pages".
//   loop-cursor     - model/list returns the same non-null cursor forever.
//   split-utf8      - model/list's response is written in two stdout chunks, split in the
//                     middle of a multi-byte UTF-8 character in one model's displayName.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "normal";
const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "codex-model-catalog.json"), "utf8"));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.method === "initialize") {
    // Sent ahead of the real response on purpose: a notification has no id, and the client
    // must ignore it rather than mistake it for (or be derailed by) the pending id:1 reply.
    send({ jsonrpc: "2.0", method: "remoteControl/status/changed", params: { status: "idle" } });
    send({ jsonrpc: "2.0", id: message.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (message.method === "initialized") return; // notification: no response expected
  if (message.method === "model/list") {
    if (mode === "error") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "boom" } });
      return;
    }
    if (mode === "null-error") {
      send({ jsonrpc: "2.0", id: message.id, result: catalog, error: null });
      return;
    }
    if (mode === "garbage") {
      process.stdout.write("not-json\n");
      return;
    }
    if (mode === "hang") return; // never respond
    if (mode === "paginated") {
      const cursor = message.params?.cursor;
      const result = cursor === undefined
        ? { data: catalog.data.slice(0, 2), nextCursor: "page-2" }
        : { data: catalog.data.slice(2), nextCursor: null };
      send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (mode === "missing-data") {
      send({ jsonrpc: "2.0", id: message.id, result: { nextCursor: null } });
      return;
    }
    if (mode === "omitted-cursor") {
      send({ jsonrpc: "2.0", id: message.id, result: { data: catalog.data } });
      return;
    }
    if (mode === "loop-cursor") {
      send({ jsonrpc: "2.0", id: message.id, result: { data: [], nextCursor: "same-cursor" } });
      return;
    }
    if (mode === "split-utf8") {
      // An em dash (U+2014) is 3 UTF-8 bytes (E2 80 94); splitting after the first byte lands
      // the chunk boundary mid-character rather than at a line boundary, so a client that
      // decodes each `data` chunk independently (`chunk.toString("utf8")`) would see two
      // replacement characters (U+FFFD) instead of the em dash — and JSON.parse would still
      // succeed on the mangled text, so nothing would surface an error.
      const mutated = {
        data: catalog.data.map((model, index) =>
          index === 0 ? { ...model, displayName: `${model.displayName} — Split` } : model),
        nextCursor: null,
      };
      const line = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: mutated })}\n`, "utf8");
      const marker = Buffer.from("—", "utf8");
      const markerIndex = line.indexOf(marker);
      const splitAt = markerIndex + 1;
      process.stdout.write(line.subarray(0, splitAt));
      setTimeout(() => process.stdout.write(line.subarray(splitAt)), 10);
      return;
    }
    // Deliberately delayed relative to account/read below: model/list (id 2) is requested
    // first but answered second, proving responses are matched by id, not by request order.
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: catalog }), 10);
    return;
  }
  if (message.method === "account/read") {
    if (mode === "hang") return;
    if (mode === "missing-account") {
      send({ jsonrpc: "2.0", id: message.id, result: { requiresOpenaiAuth: true } });
      return;
    }
    const account = mode === "signed-out" ? null : { type: "chatgpt", email: "dev@example.com", planType: "plus" };
    const respond = () => send({ jsonrpc: "2.0", id: message.id, result: { account, requiresOpenaiAuth: true } });
    if (mode === "split-utf8") {
      // Both requests arrive in the same synchronous tick (Promise.all sends them together), so
      // an immediate reply here would interleave this response's bytes between the two model/list
      // halves at the OS pipe level. Those bytes start with ASCII `{`, which is not a valid UTF-8
      // continuation byte for the pending em-dash lead byte — StringDecoder would then (correctly)
      // treat the held-back byte as genuinely invalid and emit U+FFFD immediately, which is not
      // the split-across-a-real-chunk-boundary case this scenario exists to exercise. Delaying
      // past the second model/list write (10ms) keeps the two halves adjacent.
      setTimeout(respond, 30);
      return;
    }
    respond();
    return;
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    handle(JSON.parse(line));
  }
});
