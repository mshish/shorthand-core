import {
  ClaudeAgentClient,
  CodexAgentClient,
  detectClaudeExecutable,
  detectCodexExecutable,
  type AgentClient,
} from "../src/index.js";

type Backend = "claude" | "codex";

type BridgeRequest = Readonly<{
  backend: Backend;
  prompt: string;
  systemPrompt: string;
  outputSchema: Record<string, unknown>;
}>;

const request = parseRequest(JSON.parse(await Bun.stdin.text()) as unknown);
const client = createClient(request.backend);

try {
  const response = await client.query({
    prompt: request.prompt,
    systemPrompt: request.systemPrompt,
    tools: [],
    settingSources: [],
    maxTurns: 1,
    maxAttempts: 1,
    outputSchema: request.outputSchema,
    ...(request.backend === "claude"
      ? optional("pathToClaudeCodeExecutable", detectClaudeExecutable(process.env.SHORTHAND_EVAL_CLAUDE_EXE))
      : {}),
  });
  if (response.structuredOutput === undefined) {
    const diagnostics = response.diagnostics?.join("; ");
    throw new Error(diagnostics === undefined
      ? "The local agent returned no structured output."
      : `The local agent returned no structured output: ${diagnostics}`);
  }
  process.stdout.write(JSON.stringify(response.structuredOutput));
} finally {
  await client.dispose?.();
}

function createClient(backend: Backend): AgentClient {
  if (backend === "claude") {
    return new ClaudeAgentClient({
      ...optional("model", process.env.SHORTHAND_EVAL_CLAUDE_MODEL),
      ...optional("effort", process.env.SHORTHAND_EVAL_CLAUDE_EFFORT),
    });
  }
  return new CodexAgentClient({
    ...optional("codexPathOverride", detectCodexExecutable(process.env.SHORTHAND_EVAL_CODEX_EXE)),
    ...optional("model", process.env.SHORTHAND_EVAL_CODEX_MODEL),
    ...optional("modelReasoningEffort", process.env.SHORTHAND_EVAL_CODEX_EFFORT),
  });
}

function parseRequest(value: unknown): BridgeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Bridge input must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  if (input.backend !== "claude" && input.backend !== "codex") {
    throw new TypeError('Bridge input "backend" must be "claude" or "codex".');
  }
  if (typeof input.prompt !== "string" || typeof input.systemPrompt !== "string") {
    throw new TypeError('Bridge input "prompt" and "systemPrompt" must be strings.');
  }
  if (typeof input.outputSchema !== "object" || input.outputSchema === null || Array.isArray(input.outputSchema)) {
    throw new TypeError('Bridge input "outputSchema" must be a JSON Schema object.');
  }
  return {
    backend: input.backend,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    outputSchema: input.outputSchema as Record<string, unknown>,
  };
}

function optional<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined || value.length === 0 ? {} : { [key]: value } as Record<Key, string>;
}
