import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildClaudeAgentOptions, createVaultToolGuard } from "../src/agent/client.js";
import { buildSectionOutputSchema } from "../src/agent/contract.js";

const scratch: string[] = [];
afterEach(async () => Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Claude Agent vault tool confinement", () => {
  test("allows Read inside the real vault", async () => {
    const vault = await temp("vault");
    const file = join(vault, "notes", "inside.md");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "inside");
    expect((await guard(vault)("Read", { file_path: file }, permissionOptions()))?.behavior).toBe("allow");
  });

  test("denies an absolute Read outside the vault", async () => {
    const vault = await temp("vault");
    const outside = await temp("outside");
    const file = join(outside, "secret.txt");
    await writeFile(file, "secret");
    expect((await guard(vault)("Read", { file_path: file }, permissionOptions()))?.behavior).toBe("deny");
  });

  test("denies parent traversal outside the vault", async () => {
    const parent = await temp("parent");
    const vault = join(parent, "vault");
    await mkdir(vault);
    await writeFile(join(parent, "secret.txt"), "secret");
    expect((await guard(vault)("Read", { file_path: "../secret.txt" }, permissionOptions()))?.behavior).toBe("deny");
  });

  test("denies a symlink that resolves outside the vault", async () => {
    const vault = await temp("vault");
    const outside = await temp("outside");
    const secret = join(outside, "secret.txt");
    const link = join(vault, "escape");
    await writeFile(secret, "secret");
    await symlink(outside, link, "junction");
    expect((await guard(vault)("Read", { file_path: join(link, "secret.txt") }, permissionOptions()))?.behavior).toBe("deny");
  });

  test("SDK options honor settingSources and never pre-approve tools past the vault guard", async () => {
    const vault = process.cwd();
    const options = buildClaudeAgentOptions({
      prompt: "prompt", systemPrompt: "system", cwd: vault,
      tools: ["Read"], settingSources: ["project"], maxTurns: 2, outputSchema: buildSectionOutputSchema(),
    });
    expect(options).toMatchObject({
      tools: ["Read"], settingSources: ["project"], permissionMode: "default",
      strictMcpConfig: true,
    });
    // Asserted on its own with toEqual, not folded into the toMatchObject above: a subset match
    // of `mcpServers: {}` passes just as happily when the table carries a real server, which is
    // the one outcome this assertion exists to catch.
    expect(options.mcpServers).toEqual({});
    // A bare allowedTools entry auto-approves the call before canUseTool runs, silently
    // disabling path confinement (SDK warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). It must stay absent.
    expect(options).not.toHaveProperty("allowedTools");
    expect(typeof options.canUseTool).toBe("function");
  });

  test("the output schema reaches the SDK as a json_schema output format", async () => {
    const vault = process.cwd();
    const options = buildClaudeAgentOptions({
      prompt: "prompt", systemPrompt: "system", cwd: vault,
      tools: [], settingSources: [], maxTurns: 2, outputSchema: buildSectionOutputSchema(),
    });
    expect(options.outputFormat).toEqual({ type: "json_schema", schema: buildSectionOutputSchema() });
  });

  test("model and effort are optional client-level query settings", () => {
    const request = {
      prompt: "prompt", systemPrompt: "system", tools: [], settingSources: [], maxTurns: 2,
      outputSchema: buildSectionOutputSchema(),
    } as const;
    expect(buildClaudeAgentOptions(request)).not.toHaveProperty("model");
    expect(buildClaudeAgentOptions(request)).not.toHaveProperty("effort");
    expect(buildClaudeAgentOptions(request, { model: "claude-opus-4-6", effort: "high" }))
      .toMatchObject({ model: "claude-opus-4-6", effort: "high" });
  });

  // ClaudeAgentClientOptions.effort is `string`, not the static ClaudeEffort union, precisely
  // so a value catalog.ts's AgentModel.efforts reported from the live CLI reaches the SDK even
  // when the pinned npm SDK's EffortLevel union has not caught up to that CLI version yet. An
  // effort string outside CLAUDE_EFFORT_LEVELS must still compile and flow through to the SDK
  // boundary unchanged — a static union here would make this exact case a type error.
  test("an effort level outside the static CLAUDE_EFFORT_LEVELS union still reaches the SDK options", () => {
    const request = {
      prompt: "prompt", systemPrompt: "system", tools: [], settingSources: [], maxTurns: 2,
      outputSchema: buildSectionOutputSchema(),
    } as const;
    const futureEffort = "ultrahigh";
    expect(buildClaudeAgentOptions(request, { effort: futureEffort }))
      .toMatchObject({ effort: futureEffort });
  });

  test("sessionId threads through as resume; its absence leaves resume unset", async () => {
    // buildClaudeAgentOptions eagerly begins resolving the guard root. A disposable vault
    // can be removed by afterEach before that unobserved promise settles because these
    // options-only tests never invoke the guard; a stable existing path avoids that race.
    const vault = process.cwd();
    const resumed = buildClaudeAgentOptions({
      prompt: "prompt", systemPrompt: "system", cwd: vault,
      tools: ["Read"], settingSources: ["project"], maxTurns: 2,
      outputSchema: buildSectionOutputSchema(), sessionId: "session-42",
    });
    expect(resumed.resume).toBe("session-42");
    const fresh = buildClaudeAgentOptions({
      prompt: "prompt", systemPrompt: "system", cwd: vault,
      tools: ["Read"], settingSources: ["project"], maxTurns: 2, outputSchema: buildSectionOutputSchema(),
    });
    expect(fresh).not.toHaveProperty("resume");
  });
});

function guard(vault: string) {
  return createVaultToolGuard(vault, ["Read", "Glob", "Grep"]);
}

function permissionOptions() {
  return { signal: new AbortController().signal, toolUseID: "test-tool", requestId: "test-request" };
}

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `.agent-client-${name}-`));
  scratch.push(path);
  return path;
}
