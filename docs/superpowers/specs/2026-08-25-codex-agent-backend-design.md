# Codex agent backend — design

## Why

`AgentClient` is a deliberate port: `ClaudeAgentClient` and `LlmAgentClient` already prove
that enhancement transport is provider-neutral (`docs/DESIGN.md`, "The agent is a port too").
This adds a third implementation, `CodexAgentClient`, wrapping OpenAI's `@openai/codex-sdk`,
selectable via `--backend codex` alongside the existing `claude` and `llm` backends.

## Researched facts this design depends on

Verified against `github.com/openai/codex` source and docs (not assumed):

- Package `@openai/codex-sdk` (`Codex` → `startThread()`/`resumeThread(id)` →
  `thread.runStreamed(prompt, turnOptions)`), an async-iterable event stream — the same shape
  `ClaudeAgentClient.query` already consumes from the Claude Agent SDK's `query()`.
- `TurnOptions.outputSchema` is enforced as a hard JSON-Schema constraint at the API level
  (OpenAI Structured Outputs / `response_format`), not prompt-only — matching
  `outputFormat: { type: "json_schema" }` on the Claude side. One open upstream issue
  (`openai/codex#15451`) reports possible degradation when tool calls occur in the same turn;
  not applicable here since this backend never grants working tools in the sense of exposing
  vault/file context (see Capability gap below) — worth a smoke test regardless.
- **No inline `systemPrompt` parameter.** Codex's `BaseInstructions.text` (Rust:
  `codex-rs/protocol/src/models.rs`) maps 1:1 onto the Responses API's `instructions` field,
  defaulting to Codex's own built-in prompt unless a `base_instructions` config value is
  supplied — which **replaces** it wholesale, not appends. Confirmed by reading the struct
  and its `Default` impl directly; this makes it a true equivalent of Claude's `systemPrompt`,
  reachable from the TypeScript SDK via a `base_instructions_file`-style config override.
- **No complete tool allowlist, no per-call approval callback.** `ThreadOptions` has no `tools`
  field. `config.features.shell_tool = false` removes shell execution, but `apply_patch`,
  `view_image`, and other built-ins remain. There is no
  event in `ThreadEvent` for "approval requested" the caller can answer, and no code path to
  reduce the backend to Claude's literal empty tool set. `sandboxMode` (`read-only` /
  `workspace-write` / `danger-full-access`) governs only what an *attempted* tool call may
  actually do at the OS sandbox layer (Seatbelt / bubblewrap / Windows restricted tokens) —
  it does not stop the model from seeing and attempting the call.
- Omitting `workingDirectory` makes the CLI silently default to the host Node process's
  `process.cwd()` (README: "Codex runs in the current working directory by default") and
  additionally requires that directory be a git repo unless `skipGitRepoCheck: true`.
- `codexPathOverride` (constructor-level) is the executable-path override, analogous to
  `pathToClaudeCodeExecutable`.
- Codex reads MCP servers from `$CODEX_HOME/config.toml`. A controlled live probe showed
  `--config mcp_servers={}` still listing and connecting to a named server from that file:
  config overrides merge, so assigning an empty parent table does not delete existing child
  tables. Pointing the same real CLI at a fresh `CODEX_HOME` returned "No MCP servers
  configured" and made no MCP connection attempt. `CodexOptions.env` replaces the spawned
  process environment, making that discovery-root override available through the SDK.
- ACP: no first-party OpenAI support: `codex-acp` is a third-party bridge maintained under
  `agentclientprotocol.com`/Zed, not shipped by `openai/codex`. Out of scope per the
  established condition ("only if Codex SDK is fully ACP compliant" — it is not).

## Capability gap this design accepts, deliberately

For `ClaudeAgentClient`, `tools: []` plus a `canUseTool` deny-all callback literally removes
Write/Edit/Bash. Codex cannot make that same guarantee. Disabling `features.shell_tool`
removes shell execution, but other built-ins remain; `sandboxMode: "read-only"` is therefore
still an after-the-fact OS boundary for attempted writes, not a tool-availability boundary.

Decision (confirmed): `CodexAgentClient` never receives vault or note content as filesystem
context. `supportsVaultTools = false`, matching `LlmAgentClient` — `EnhanceRunner` already
downgrades any client that declares this to the `tick` tier and withholds `cwd`, so no
`EnhanceRunner` change is needed. This sidesteps the gap rather than accepting it: the
sandboxed-but-attempted working directory is a scratch directory this client owns and never
contains vault or note content. This limits what the application intentionally exposes; it is
not a claim that every remaining built-in is path-confined.

MCP needs its own boundary because Codex does not apply `sandboxMode` to MCP tools. Each client
therefore creates a second scratch subdirectory and supplies it as `CODEX_HOME` through
`CodexOptions.env`. The directory has no `config.toml`; when no API key override is supplied,
the client copies only the ambient `auth.json` into it so CLI login can still work without
copying MCP servers, skills, or other operator configuration. The isolated home is reused for
the client lifetime so session resume still works, then removed with the same best-effort exit
cleanup as the working directory.

`docs/DESIGN.md`'s Invariants section must be updated in the same change to scope the "no
write tool" claim per backend, rather than leaving it reading as a codebase-wide guarantee it
no longer is.

## `CodexAgentClient` (`src/agent/codex-client.ts`)

```ts
export class CodexAgentClient implements AgentClient {
  readonly supportsVaultTools = false;
  constructor(options?: Readonly<{ codexPathOverride?: string; apiKey?: string }>);
  query(request: AgentQueryRequest): Promise<AgentQueryResponse>;
}
```

- **Runtime root**: created lazily on first `query()` call (`mkdtemp` under the OS temp dir),
  with separate `work` and isolated `home` children, reused for every subsequent call on the
  same instance, and best-effort removed on process
  exit. One instance already corresponds to one capture/runner lifecycle elsewhere in this
  codebase (`ClaudeAgentClient`/`LlmAgentClient` are constructed once per `EnhanceRunner`), so
  this matches existing lifetime assumptions rather than introducing a new one.
- Every call passes: `workingDirectory: <scratch dir>` (never `request.cwd`, never omitted —
  structurally: the field is not read from `request` at all), `skipGitRepoCheck: true`,
  `sandboxMode: "read-only"`, `approvalPolicy: "never"`, unconditionally — not gated on
  whether a `cwd` was requested, because there is no deny-all fallback to drop to.
- **System prompt**: written once, lazily, to a temp file on first call
  (`ENHANCEMENT_SAFETY_PREAMBLE` + guidance, i.e. `request.systemPrompt` verbatim — already
  composed by `EnhanceRunner`), reused as the `base_instructions` config override thereafter.
  This relies on `request.systemPrompt` being identical across every call on one client
  instance, which already holds today (`EnhanceRunnerOptions.guidance` is fixed at
  construction — see `docs/AGENTS.md` "the enhancement prompt is split, deliberately"). The
  comment at the write site names this dependency explicitly, so a future change that makes
  `systemPrompt` vary per call fails loudly in review rather than silently serving stale
  instructions.
- **`request.tools` is read and deliberately never forwarded** — no allowlist exists on the
  Codex side. A code comment states why, matching this codebase's "comments explain why"
  style, so this doesn't read as an oversight in a later diff.
- **`request.outputSchema`** forwards directly to `TurnOptions.outputSchema`.
- **Session id**: `request.sessionId` present → `codex.resumeThread(id, opts)`; absent →
  `codex.startThread(opts)`. Response's `sessionId` taken from the thread-started event,
  mirroring how `ClaudeAgentClient` captures `session_id` off the first message and never
  overwrites it.
- **Abort**: `request.signal` forwarded to `TurnOptions.signal` (the SDK forwards it straight
  into `child_process.spawn`'s own `signal`, so this is real cancellation, not cooperative).
- **Streaming loop**: iterate `thread.runStreamed()`; `turn.completed` carries structured
  output, `turn.failed`/`error` events map to `AgentQueryError`, mirroring
  `ClaudeAgentClient.query`'s `is_error` / exhaustion-diagnostics handling so the two
  implementations read as siblings, not divergent styles.
- **Auth**: `apiKey` remains an optional constructor override. Without it, the isolated home
  receives a copy of the ambient home's `auth.json` and nothing else. This preserves the
  locally logged-in posture without inheriting `config.toml`; if no auth file exists, the CLI
  reports its normal unauthenticated failure.
- **Executable path**: `codexPathOverride` constructor option only. No new field on the
  shared `AgentQueryRequest`/`EnhanceRunnerOptions` contract — `pathToClaudeCodeExecutable`
  is already Claude-specific by name, and generalizing it is an unrelated breaking rename this
  task doesn't need. `bin/shorthand-notes.ts` resolves an optional `SHORTHAND_CODEX_EXE`
  env var / `--codex-exe` flag and passes it to the constructor, mirroring
  `detectClaudeExecutable`'s env-var path but *not* copying its hardcoded Windows
  `~/.local/bin/claude.exe` fallback — that path is specific to the `claude` CLI's own
  installer behavior and unverified for `codex`'s installer, so it is not carried over as an
  unverified guess.

## CLI wiring (`bin/shorthand-notes.ts`)

- `selectAgent()`: `--backend` accepts `claude | llm | codex`; `codex` branch constructs
  `new CodexAgentClient({ codexPathOverride: detectCodexExecutable(...) })`. `detectCodexExecutable`
  is a new export from `src/agent/codex-client.ts`, alongside `CodexAgentClient` — same file,
  same pairing `detectClaudeExecutable` has with `ClaudeAgentClient` in `client.ts`. Precedence
  (`--agent-stub` wins over `--backend`) is unchanged.
- Usage/help text and the `--backend must be claude or llm` error message extended to name
  `codex`.

## Dependencies and build

- `package.json`: add `@openai/codex-sdk` to `dependencies`.
- `esbuild` bundle command: add `--external:@openai/codex-sdk`, matching the existing
  externals for `@anthropic-ai/claude-agent-sdk` and the AI SDK packages (all provider SDKs
  are kept external, never bundled).

## Exports (`src/index.ts`)

Add `CodexAgentClient` and `detectCodexExecutable` to the root entry point's explicit export
list, alongside `ClaudeAgentClient`/`detectClaudeExecutable` and `LlmAgentClient`. Additive
only — no existing export changes shape —
so per `AGENTS.md`/`CLAUDE.md`'s cross-repo rule, this does **not** make the Obsidian plugin
part of this task.

## Docs

- `docs/DESIGN.md`: scope the "the agent has no write tool" invariant per backend (see
  Capability gap above) — required, not optional, since leaving it unconditional would make
  the document actively wrong once this ships.
- `README.md`: document `--backend codex` alongside the existing `claude`/`llm` entries.
- `docs/AGENTS.md`: no limit/gate/timeout numbers are introduced by this change, so
  `docs/ENHANCEMENT-LIMITS.md` is unaffected — confirm this holds at implementation time
  rather than assuming it in advance.

## Testing

- `test/codex-client.test.ts`: `mock.module("@openai/codex-sdk", () => ({...}))`, mirroring
  `test/llm-client.test.ts`'s approach for mocking the `ai` package — the established pattern
  for testing a client that wraps a third-party SDK in this codebase. Covers: session
  resume vs. fresh thread, abort forwarding, `turn.failed` → `AgentQueryError`, structured
  output pass-through, scratch-dir reuse across repeated calls, that `workingDirectory` is
  never derived from `request.cwd`, the exact `features.shell_tool = false` pin, and replacement
  of an ambient `CODEX_HOME` with the isolated home.
- `selectAgent()` gets a `--backend codex` case in its existing test coverage
  (`test/shorthand-notes` or wherever `selectAgent` is currently tested — confirm exact file
  at implementation time).
- No new e2e coverage needed: `--agent-stub` already exercises the CLI/runner path
  independently of which backend it stands in for (`ExecutableAgentStub` is backend-agnostic
  by construction, per `selectAgent`'s stated precedence).

## Explicitly out of scope

- ACP / Agent Client Protocol — condition not met (no first-party Codex ACP support).
- Vault/filesystem context for Codex-backed passes — accepted gap, not deferred; would need a
  materially different capability from OpenAI (a real per-call approval hook) to reconsider.
- Any change to `AgentClient`, `AgentQueryRequest`/`AgentQueryResponse`, or `EnhanceRunner`.
- Generalizing `pathToClaudeCodeExecutable` into a provider-neutral field name.
