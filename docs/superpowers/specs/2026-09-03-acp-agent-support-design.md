# ACP Agent Support for Shorthand

**Date:** 2026-09-03  
**Status:** Approved  
**Target Repositories:** `shorthand-core`, `shorthand-obsidian-plugin`

---

## 1. Objective & Context

Shorthand enhances speech-to-text meeting transcripts into structured, Obsidian-flavored Markdown notes. Today it supports three enhancement backends:
1. **Claude Code** (`claude-agent-sdk`): Via `@anthropic-ai/claude-agent-sdk` driving the `claude` CLI with vault path confinement.
2. **Codex** (`codex`): Via `@openai/codex-sdk` driving the `codex` CLI with isolated `CODEX_HOME` and scratch workspace.
3. **Direct LLMs** (`llm`): Via Vercel AI SDK (`ai`) over Anthropic, OpenAI, or OpenAI-compatible endpoints.

This design introduces a 4th backend: **ACP (Agent Client Protocol) Agents** (`acp`), utilizing the official open-source [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) (v1.4.0, maintained by Zed Industries under Apache-2.0). 

The initial primary agent client is the **Cursor CLI** (`agent acp`), reusing existing local Cursor authentication (`cursor_login`). The architecture is dual-layer: preconfigured with Cursor CLI defaults and auto-detection, but fully general to support custom local ACP binaries (e.g. Antigravity ACP) and remote networked ACP servers over WebSocket (`ws://` / `wss://`) or Streamable HTTP (`http://` / `https://`).

---

## 2. Architecture & Public Surface

### 2.1 Core Interface Compliance
In `shorthand-core`, `AcpAgentClient` implements the existing `AgentClient` interface:

```typescript
export interface AgentClient {
  readonly supportsVaultTools?: boolean;
  query(request: AgentQueryRequest): Promise<AgentQueryResponse>;
  dispose?(): Promise<void>;
}
```

### 2.2 Safety & Sandboxing Invariants
* **`supportsVaultTools = false`**: Matching `CodexAgentClient` and `LlmAgentClient`. `EnhanceRunner` automatically withholds vault `cwd` paths and downgrades passes to the non-filesystem `tick` tier.
* **Scratch Confinement**: The working directory provided to `session/new` is strictly a dedicated, temporary scratch directory created via `mkdtemp` and cleaned up on client disposal. Vault content is never exposed as an on-disk working directory.
* **Ambient MCP Lockout**: `session/new` explicitly passes `mcpServers: []`. This prevents untrusted meeting transcript text from invoking tools configured in the user's ambient Cursor or system MCP tables.
* **Mode Restriction**: For Cursor CLI and compatible agents, sessions run in `mode: "ask"` (or `"plan"`), restricting the agent to non-destructive Q&A and planning without edit or terminal execution tools.

### 2.3 Transport & Client Configuration
```typescript
export type AcpTransportConfig =
  | Readonly<{
      type: "stdio";
      /** Executable path or command. Blank inherits auto-detected Cursor CLI. */
      command?: string;
      /** Arguments passed to command. Defaults to ["acp"]. */
      args?: readonly string[];
      /** Environment variable overrides. */
      env?: NodeJS.ProcessEnv;
    }>
  | Readonly<{
      type: "network";
      /** Endpoint URL (ws://, wss://, http://, https://). */
      url: string;
      /** Optional bearer token or authorization header value. */
      authToken?: string;
    }>;

export type AcpAgentClientOptions = Readonly<{
  transport: AcpTransportConfig;
  /** Model ID to select (e.g. "claude-sonnet-5[...]"). Blank inherits agent default. */
  model?: string;
  /** Execution mode: defaults to "ask" for non-destructive note synthesis. */
  mode?: "ask" | "plan" | "agent";
  /** Scratch working directory for session/new. Defaults to a temporary scratch directory. */
  scratchDirectory?: string;
  /** Connection and request timeout in milliseconds. Defaults to 60,000ms. */
  timeoutMs?: number;
}>;
```

---

## 3. Detailed Component Design

### 3.1 Connection & Process Lifecycle
`AcpAgentClient` (`shorthand-core/src/agent/acp-client.ts`):
1. **Connection**:
   * **`stdio`**: Spawns the CLI child process via `node:child_process.spawn`. Pipes `stdin` and `stdout` through `@agentclientprotocol/sdk` stream utilities (`ndJsonStream`).
   * **`network`**: Connects to the remote endpoint using `@agentclientprotocol/sdk/experimental/ws-client` or `http-client`.
2. **Handshake**:
   * Sends `initialize` with `protocolVersion: 1` and client information (`{ name: "shorthand", version: ... }`).
3. **Session Management**:
   * First turn: Calls `session/new` with `cwd: scratchDir`, `mcpServers: []`, and `mode: "ask"`.
   * Sets model configuration if specified in options via `session/set_config_option` (or on initial session creation).
   * Stores `sessionId`.
   * Subsequent turns: When `request.sessionId` matches the active session, reuses the live connection, preserving conversational context across the meeting.
4. **Disposal (`dispose()`)**:
   * Closes active sessions.
   * For `stdio`, terminates the child process (`SIGTERM`, followed by `SIGKILL` if unhandled).
   * Deletes the temporary scratch directory.

### 3.2 Structured Output & Section Extraction
Because the ACP protocol specification does not currently mandate a wire-level `json_schema` parameter on `session/prompt`, output structuring uses a multi-layer defense:

1. **Explicit Prompt Directive**:
   `AcpAgentClient` appends strict output requirements to the prompt:
   ```
   CRITICAL OUTPUT REQUIREMENT:
   You must respond with ONLY a single raw JSON object matching this schema:
   {
     "sections": [
       {
         "heading": "string (one line, no level-two headings)",
         "markdown": "string (Obsidian-flavored markdown)"
       }
     ]
   }

   DO NOT include any introductory or concluding conversational prose.
   DO NOT wrap the output in explanations.
   Output ONLY the valid JSON object starting with "{" and ending with "}".
   ```
2. **Stream Processing**:
   * Listens for `session/update` notifications.
   * Gathers text chunks from `sessionUpdate === "agent_message_chunk"`.
3. **JSON Extraction**:
   * When `session/prompt` completes (`stopReason: "end_turn"`), the client strips markdown code fences (` ```json ... ``` `).
   * If any conversational preamble precedes the JSON, it extracts the substring between the first `{` and the last `}`.
   * Parses the string via `JSON.parse`. If parsing fails, returns `structuredOutput: undefined` and diagnostic text.
4. **Validation Gate & Corrective Retry**:
   * Output is verified by `validateSectionOutput()`, enforcing the Zod schema, character limits, marker token absence, and writer formatting.
   * If parsing fails or the schema is invalid, Shorthand's `queryForSections()` automatically invokes a 2nd corrective attempt containing the exact validation error message.

### 3.3 Cancellation & Abort
* When `request.signal` aborts, `AcpAgentClient` immediately dispatches a `session/cancel` notification.
* If the child process does not acknowledge cancellation within 2 seconds, it is forcibly terminated.

### 3.4 Executable Detection
`detectCursorExecutable(override?: string, environment?: NodeJS.ProcessEnv): string | undefined`:
* Respects explicit parameter override, then `SHORTHAND_CURSOR_EXE` or `SHORTHAND_ACP_EXE`.
* On Windows: Checks `agent.cmd`, `agent.ps1`, `cursor.cmd`, `cursor.exe` on `PATH`, and standard AppData locations (`%LOCALAPPDATA%\Programs\cursor\resources\app\bin`, `%LOCALAPPDATA%\cursor-agent`).
* On macOS/Linux: Checks `agent` and `cursor` on `PATH`, `~/.local/bin/agent`, and `/usr/local/bin/agent`.

### 3.5 Model Catalog Discovery
`listAcpModels(options: ListAcpModelsOptions): Promise<AgentCatalog>` (`src/agent/acp-catalog.ts`):
* Spawns a transient ACP server instance or connects to the network endpoint.
* Executes `initialize` and reads authentication capabilities (`authMethods`, e.g. `cursor_login`).
* Calls `session/new` with a scratch directory and `mcpServers: []`.
* Extracts `models.availableModels` and maps each entry into `AgentModel`:
  * `id`: Model slug (e.g. `claude-sonnet-5[...]`, `gpt-5.4[...]`).
  * `displayName`: User-friendly model name.
  * `description`: Model ID or capability summary.
  * `efforts`: Bracket parameters or empty array.
* Terminates probe process and returns `AgentCatalog`:
  ```typescript
  {
    models: mappedModels,
    signedIn: authActive,
    account: "Cursor CLI"
  }
  ```
* Maps failures to `AgentCatalogError` (`"executable-not-found"`, `"spawn-failed"`, `"timeout"`, `"protocol"`).

---

## 4. Obsidian Plugin Integration

### 4.1 Settings Schema (`src/settings.ts`)
* Extend `ENHANCEMENT_BACKENDS`:
  ```typescript
  const ENHANCEMENT_BACKENDS = ["claude-agent-sdk", "llm", "codex", "acp"] as const;
  ```
* Add settings fields:
  * `acpTransport`: `"stdio" | "network"` (default: `"stdio"`).
  * `acpExecutable`: string (default: `""`, blank auto-detects Cursor CLI).
  * `acpArgs`: string (default: `"acp"`).
  * `acpNetworkUrl`: string (default: `""`).
  * `acpAuthToken`: string (default: `""`).
  * `acpModel`: string (default: `""`, blank inherits agent default).
* Update `normalizePluginSettings` to validate and sanitize all new fields.

### 4.2 Settings UI (`src/settings-display.ts`)
* Backend selector: Adds `"acp": "Cursor / ACP Agent"`.
* When `backend === "acp"`:
  * Renders preset selector: "Cursor CLI (stdio - default)", "Custom Command (stdio)", "Remote Server (network)".
  * Dynamic model dropdown fetched asynchronously via `listAcpModels()`.
  * Advanced collapsible section exposing executable path override, command arguments, and network endpoint URL / token.

### 4.3 Plugin Lifecycle Wiring (`main.ts`)
In `createEnhanceRunner()`:
* When `backend === "acp"`, resolves executable or network URL, instantiates `AcpAgentClient`, and passes it to `EnhanceRunner`.

---

## 5. Testing & Verification

1. **`shorthand-core`**:
   * Unit tests for `detectCursorExecutable`.
   * Unit tests for `listAcpModels` with mocked stdio stream fixtures.
   * Full test suite for `AcpAgentClient`:
     * JSON output parsing and markdown fence stripping.
     * Schema rejection and corrective prompt flow.
     * Session continuation across multiple query calls.
     * Abort signal handling and process termination.
     * Verification that `supportsVaultTools === false` and `mcpServers === []`.
2. **`shorthand-obsidian-plugin`**:
   * Unit tests for settings normalization and serialization in `test/plugin-settings.test.ts`.
   * Bundle compilation verification in `test/plugin-bundle.test.ts`.
3. **End-to-End Live Verification**:
   * Run a live capture pass using the installed Cursor CLI (`agent acp`) and verify note enhancement output.
