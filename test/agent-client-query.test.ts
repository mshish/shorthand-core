import { describe, expect, mock, test } from "bun:test";
import type { AgentQueryRequest } from "../src/agent/contract.js";

let messages: readonly Record<string, unknown>[] = [];

// The SDK module is replaced process-wide, which is safe here: `src/agent/client.ts` is the
// only file in the repo that imports it, and no other suite drives a real query.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() { for (const message of messages) yield message; },
    interrupt: async () => {},
  }),
}));

// Imported after the mock is registered, so the client binds to the fake `query`.
const { ClaudeAgentClient } = await import("../src/agent/client.js");
const { AgentQueryError, buildSectionOutputSchema, queryForSections } = await import("../src/agent/contract.js");

describe("ClaudeAgentClient result harvesting", () => {
  test("returns the structured output the result message carried", async () => {
    messages = [
      { type: "system", session_id: "session-1" },
      { type: "assistant", session_id: "session-1", message: { content: [{ type: "text", text: "chatter" }] } },
      {
        type: "result", subtype: "success", is_error: false, session_id: "session-1",
        structured_output: { sections: [{ heading: "Summary", markdown: "Done" }] },
      },
    ];
    expect(await new ClaudeAgentClient().query(agentRequest())).toEqual({
      structuredOutput: { sections: [{ heading: "Summary", markdown: "Done" }] },
      sessionId: "session-1",
    });
  });

  test("exhausted schema retries come back as absent output, not a thrown error", async () => {
    // The SDK reports this as an ERROR result (SDKResultError), so the generic is_error
    // throw would end the pass here. The contract loop's second attempt is worth taking:
    // it re-asks on a clean turn with the failure stated in the prompt.
    messages = [{
      type: "result", subtype: "error_max_structured_output_retries", is_error: true,
      session_id: "session-2", terminal_reason: "structured_output_retry_exhausted",
      errors: ["schema validation failed 3 times"],
    }];
    // The SDK's own diagnostics come back with it: they are the only description of what
    // the model got wrong, and the corrective attempt is worthless without them.
    expect(await new ClaudeAgentClient().query(agentRequest())).toEqual({
      structuredOutput: undefined,
      sessionId: "session-2",
      diagnostics: ["schema validation failed 3 times"],
    });
  });

  test("the exhaustion subtype alone is enough, with no terminal_reason to corroborate it", async () => {
    // `terminal_reason` is optional on SDKResultError. A fixture that sets both fields
    // proves neither clause of the check on its own, and the missing clause would only
    // surface as a whole pass ending on a rejection the loop could have corrected.
    messages = [{
      type: "result", subtype: "error_max_structured_output_retries", is_error: true,
      session_id: "session-7", errors: ["schema validation failed 3 times"],
    }];
    expect(await new ClaudeAgentClient().query(agentRequest())).toEqual({
      structuredOutput: undefined,
      sessionId: "session-7",
      diagnostics: ["schema validation failed 3 times"],
    });
  });

  test("the exhaustion terminal_reason alone is enough, under a subtype that would otherwise throw", async () => {
    messages = [{
      type: "result", subtype: "error_during_execution", is_error: true, session_id: "session-8",
      terminal_reason: "structured_output_retry_exhausted", errors: ["schema validation failed 3 times"],
    }];
    expect(await new ClaudeAgentClient().query(agentRequest())).toEqual({
      structuredOutput: undefined,
      sessionId: "session-8",
      diagnostics: ["schema validation failed 3 times"],
    });
  });

  test("an exhaustion result with an empty errors array reports no diagnostics rather than an empty one", async () => {
    messages = [{
      type: "result", subtype: "error_max_structured_output_retries", is_error: true,
      session_id: "session-9", errors: [],
    }];
    expect(await new ClaudeAgentClient().query(agentRequest())).toEqual({
      structuredOutput: undefined,
      sessionId: "session-9",
    });
  });

  test("a genuine error result throws with the SDK's own diagnostics", async () => {
    // SDKResultError has no `result` string; reading only that field would throw away
    // every reason the SDK gave.
    messages = [{
      type: "result", subtype: "error_during_execution", is_error: true, session_id: "session-3",
      errors: ["upstream 500", "retry budget spent"],
    }];
    await expect(new ClaudeAgentClient().query(agentRequest())).rejects.toThrow(AgentQueryError);
    await expect(new ClaudeAgentClient().query(agentRequest())).rejects.toThrow("upstream 500; retry budget spent");
  });

  test("a failure with no diagnostics still names the subtype instead of reporting nothing", async () => {
    // `errors` is absent from SDKResultSuccess and may be empty on SDKResultError, so the
    // message must degrade to something an operator can act on — never an empty fragment
    // or the string "undefined".
    for (const [subtype, session, errors] of [
      ["error_max_turns", "session-a", undefined],
      ["error_max_budget_usd", "session-b", []],
    ] as const) {
      messages = [{
        type: "result", subtype, is_error: true, session_id: session,
        ...(errors === undefined ? {} : { errors }),
      }];
      await expect(new ClaudeAgentClient().query(agentRequest()))
        .rejects.toThrow(`Claude Agent SDK result failed (${subtype}).`);
    }
  });

  test("a stream that never named a session is a transport failure", async () => {
    messages = [{ type: "result", subtype: "success", is_error: false, structured_output: {} }];
    await expect(new ClaudeAgentClient().query(agentRequest())).rejects.toThrow("no session id");
  });

  test("a stream that ended without a result message is a transport failure, not an empty answer", async () => {
    // A CLI too old for `outputFormat`, an abort, or a killed subprocess all end the stream
    // with no result. Returning `structuredOutput: undefined` here would be indistinguishable
    // from the SDK exhausting its schema retries, which is a claim about the model.
    messages = [
      { type: "system", session_id: "session-4" },
      { type: "assistant", session_id: "session-4", message: { content: [{ type: "text", text: "thinking" }] } },
    ];
    await expect(new ClaudeAgentClient().query(agentRequest())).rejects.toThrow(AgentQueryError);
    await expect(new ClaudeAgentClient().query(agentRequest())).rejects.toThrow("without a result message");
  });
});

describe("what the contract loop makes of a real client's stream", () => {
  test("a result-less stream is reported as a query error, never as bad model output", async () => {
    messages = [{ type: "system", session_id: "session-5" }];
    const errors: string[] = [];
    const result = await queryForSections(new ClaudeAgentClient(), contractRequest(), [], {
      error: (message) => errors.push(String(message)),
    });
    // One attempt, not two: there is nothing for a corrective prompt to correct.
    expect(result).toMatchObject({ status: "skipped", reason: "query-error", attempts: 1 });
    expect(errors[0]).toContain("AGENT PASS FAILED");
  });

  test("exhausted schema retries still buy the second, corrective attempt", async () => {
    messages = [{
      type: "result", subtype: "error_max_structured_output_retries", is_error: true,
      session_id: "session-6", terminal_reason: "structured_output_retry_exhausted",
      errors: ["sections: expected array, received string"],
    }];
    const result = await queryForSections(new ClaudeAgentClient(), contractRequest(), [], { error: () => {} });
    expect(result).toMatchObject({ status: "skipped", reason: "invalid-output", attempts: 2 });
  });
});

function agentRequest(): AgentQueryRequest {
  return {
    prompt: "prompt",
    systemPrompt: "system",
    tools: [],
    settingSources: [],
    maxTurns: 1,
    outputSchema: { type: "object" },
  };
}

function contractRequest(): AgentQueryRequest {
  return { ...agentRequest(), outputSchema: buildSectionOutputSchema() };
}
