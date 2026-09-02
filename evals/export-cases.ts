import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildSectionOutputSchema,
  DEFAULT_ASSISTED_NOTES_EDITORIAL_GUIDANCE,
  DEFAULT_MEETING_EDITORIAL_GUIDANCE,
  ENHANCEMENT_SAFETY_PREAMBLE,
  type NoteTakingMode,
} from "../src/agent/contract.js";
import { buildPassPrompt } from "../src/agent/runner.js";
import type { Section } from "../src/note/markers.js";

type EvalCase = Readonly<{
  id: string;
  mode: NoteTakingMode;
  userName?: string;
  currentSections: readonly Section[];
  userNotes: string;
  transcript: string;
  expectedOutput: string;
  requiresTable: boolean;
  requiresCallout: boolean;
}>;

const casesPath = fileURLToPath(new URL("./cases.json", import.meta.url));
const cases = JSON.parse(await readFile(casesPath, "utf8")) as EvalCase[];
const outputSchema = buildSectionOutputSchema();

process.stdout.write(JSON.stringify(cases.map((testCase) => {
  const guidance = testCase.mode === "assisted-notes"
    ? DEFAULT_ASSISTED_NOTES_EDITORIAL_GUIDANCE
    : DEFAULT_MEETING_EDITORIAL_GUIDANCE;
  return {
    ...testCase,
    systemPrompt: `${ENHANCEMENT_SAFETY_PREAMBLE}\n\n${guidance}`,
    prompt: buildPassPrompt(
      testCase.currentSections,
      testCase.transcript,
      testCase.userNotes,
      "tick",
      {
        mode: testCase.mode,
        ...(testCase.userName === undefined ? {} : { userName: testCase.userName }),
      },
    ),
    outputSchema,
  };
})));
