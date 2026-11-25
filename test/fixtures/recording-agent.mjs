#!/usr/bin/env node
// Like fake-agent.mjs, but first saves the request it was given to the file named by
// SHORTHAND_TEST_AGENT_REQUEST, so a test can check what the agent was told.
import { writeFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk.toString("utf8");
const request = JSON.parse(input);
if (!Array.isArray(request.tools)) throw new Error("Expected tools in stub request.");
if (process.env.SHORTHAND_TEST_AGENT_REQUEST) writeFileSync(process.env.SHORTHAND_TEST_AGENT_REQUEST, input, "utf8");
process.stdout.write(JSON.stringify({
  structuredOutput: { sections: [{ heading: "Stub summary", markdown: "Offline result" }] },
}));
