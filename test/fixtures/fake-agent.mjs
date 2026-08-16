#!/usr/bin/env node

let input = "";
for await (const chunk of process.stdin) input += chunk.toString("utf8");
const request = JSON.parse(input);
if (!Array.isArray(request.tools)) throw new Error("Expected tools in stub request.");
process.stdout.write(JSON.stringify({
  finalAssistantMessage: "```json\n[{\"heading\":\"Stub summary\",\"markdown\":\"Offline result\"}]\n```",
  costUsd: 0.01,
}));
