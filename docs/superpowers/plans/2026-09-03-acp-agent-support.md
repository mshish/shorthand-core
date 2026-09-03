# ACP Agent Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for ACP (Agent Client Protocol) agents as an AI note-taking enhancement backend in `shorthand-core` and `shorthand-obsidian-plugin`, defaulting to the Cursor CLI (`agent acp`) over local stdio with support for custom ACP commands and remote WebSocket/HTTP endpoints.

**Architecture:** Implement `AcpAgentClient` complying with `AgentClient` in `shorthand-core` using `@agentclientprotocol/sdk` (v1.4.0). Handle JSON-RPC over stdio and network stream transports, manage session lifecycle (`session/new`, `session/prompt`, `session/cancel`), strictly confine to scratch directories with `supportsVaultTools = false` and `mcpServers = []`, extract structured note sections via JSON boundary extraction with automatic self-healing retries, and expose dynamic model discovery and settings in the Obsidian plugin.

**Tech Stack:** TypeScript, Node.js (`child_process`, `net`, `stream`), `@agentclientprotocol/sdk` (v1.4.0), Zod, Bun (test runner in core/plugin), esbuild.

**Spec:** `docs/superpowers/specs/2026-09-03-acp-agent-support-design.md`

## Global Constraints
* In `shorthand-core`: No `export *` in entry points. Every export must be explicitly named.
* `supportsVaultTools = false`: Vault files must never be exposed as tool targets.
* Safety preamble: Always prepended by `EnhanceRunner`; ACP sessions run in non-destructive `mode: "ask"` with `mcpServers: []`.
* Single source of truth for backends: `ENHANCEMENT_BACKENDS` in `src/settings.ts` narrowed via `isEnhancementBackend`.
* Cross-repo release order: Complete, test, push, and tag in `shorthand-core` first; bump plugin pin as step 1 of plugin work.

---

### Task 1: Add `@agentclientprotocol/sdk` to `shorthand-core`

**Files:**
- Modify: `shorthand-core/package.json`

**Interfaces:**
- Produces: `@agentclientprotocol/sdk` dependency available for imports in `src/agent/`.

- [ ] **Step 1: Add `@agentclientprotocol/sdk` to `dependencies` in `package.json`**

Edit `shorthand-core/package.json` to add `"@agentclientprotocol/sdk": "^1.4.0"` under `dependencies`.

- [ ] **Step 2: Run `bun install` to update the lockfile**

Run: `bun install` in `shorthand-core`
Expected: Lockfile updated, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add @agentclientprotocol/sdk dependency"
```

---

### Task 2: Executable Detection (`detectCursorExecutable`)

**Files:**
- Create: `shorthand-core/src/agent/acp-client.ts` (initial skeleton with `detectCursorExecutable`)
- Create: `shorthand-core/test/acp-detect.test.ts`

**Interfaces:**
- Produces: `detectCursorExecutable(override?: string, environment?: NodeJS.ProcessEnv): string | undefined`

- [ ] **Step 1: Write failing test for `detectCursorExecutable`**

Create `shorthand-core/test/acp-detect.test.ts`:
```typescript
import { describe, expect, it } from "bun:test";
import { detectCursorExecutable } from "../src/agent/acp-client.js";

describe("detectCursorExecutable", () => {
  it("honours an explicit override", () => {
    expect(detectCursorExecutable("D:\\custom\\agent.exe")).toBe("D:\\custom\\agent.exe");
  });

  it("honours SHORTHAND_CURSOR_EXE from environment", () => {
    const env = { SHORTHAND_CURSOR_EXE: "C:\\bin\\agent.cmd" };
    expect(detectCursorExecutable(undefined, env)).toBe("C:\\bin\\agent.cmd");
  });

  it("honours SHORTHAND_ACP_EXE as a fallback environment variable", () => {
    const env = { SHORTHAND_ACP_EXE: "C:\\bin\\acp-agent.exe" };
    expect(detectCursorExecutable(undefined, env)).toBe("C:\\bin\\acp-agent.exe");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/acp-detect.test.ts` in `shorthand-core`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `detectCursorExecutable`**

Create `shorthand-core/src/agent/acp-client.ts`:
```typescript
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export function detectCursorExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = override ?? environment.SHORTHAND_CURSOR_EXE ?? environment.SHORTHAND_ACP_EXE;
  if (configured !== undefined && configured.length > 0) return resolve(configured);

  const pathEntries = (environment.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const localAppData = environment.LOCALAPPDATA ?? join(environment.USERPROFILE ?? homedir(), "AppData", "Local");
    candidates.push(
      join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
      join(localAppData, "cursor-agent", "agent.ps1"),
    );
    for (const dir of pathEntries) {
      candidates.push(
        join(dir, "agent.cmd"),
        join(dir, "agent.ps1"),
        join(dir, "cursor.cmd"),
        join(dir, "cursor.exe"),
      );
    }
  } else {
    const home = environment.HOME ?? homedir();
    candidates.push(
      join(home, ".local", "bin", "agent"),
      "/usr/local/bin/agent",
    );
    for (const dir of pathEntries) {
      candidates.push(join(dir, "agent"), join(dir, "cursor"));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/acp-detect.test.ts` in `shorthand-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/acp-client.ts test/acp-detect.test.ts
git commit -m "feat(agent): implement detectCursorExecutable"
```

---

### Task 3: ACP Model Catalog Discovery (`listAcpModels`)

**Files:**
- Create: `shorthand-core/src/agent/acp-catalog.ts`
- Create: `shorthand-core/test/acp-catalog.test.ts`

**Interfaces:**
- Consumes: `AgentCatalog`, `AgentModel`, `AgentCatalogError`, `CATALOG_TIMEOUT_MS` from `catalog.js`
- Produces: `listAcpModels(options?: ListAcpModelsOptions): Promise<AgentCatalog>`

- [ ] **Step 1: Write unit tests for `listAcpModels`**

Create `shorthand-core/test/acp-catalog.test.ts` testing:
* Protocol response mapping: converts ACP `availableModels` array into `AgentCatalog`.
* Rejects on spawn failure / executable not found (`AgentCatalogError`).
* Correctly checks authentication method status.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/acp-catalog.test.ts` in `shorthand-core`
Expected: FAIL.

- [ ] **Step 3: Implement `listAcpModels`**

Implement `src/agent/acp-catalog.ts` supporting `stdio` and `network` options, performing the handshake sequence (`initialize` -> `session/new`), extracting models, and cleanly closing the probe connection.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/acp-catalog.test.ts` in `shorthand-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/acp-catalog.ts test/acp-catalog.test.ts
git commit -m "feat(agent): implement listAcpModels catalog probe"
```

---

### Task 4: Implement `AcpAgentClient`

**Files:**
- Modify: `shorthand-core/src/agent/acp-client.ts`
- Create: `shorthand-core/test/acp-client.test.ts`

**Interfaces:**
- Consumes: `AgentClient`, `AgentQueryRequest`, `AgentQueryResponse`, `AgentQueryError` from `contract.js`
- Produces: `AcpAgentClient` implementing `AgentClient` (`supportsVaultTools: false`).

- [ ] **Step 1: Write failing tests for `AcpAgentClient`**

Create `shorthand-core/test/acp-client.test.ts`:
* Invariants: `supportsVaultTools === false`.
* Successful query: parses raw JSON object from streamed message chunks.
* Robust JSON extraction: unwraps ```` ```json ... ``` ```` fences and ignores preambles.
* Validation failure: surfaces diagnostic text for `validateSectionOutput` / `queryForSections` retry.
* Session reuse: sends subsequent prompts to the same session when `sessionId` matches.
* Cancellation: handles `request.signal` abort by sending `session/cancel`.
* Scratch cleanup on `dispose()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/acp-client.test.ts` in `shorthand-core`
Expected: FAIL.

- [ ] **Step 3: Implement `AcpAgentClient` in `src/agent/acp-client.ts`**

Implement `AcpAgentClient` with:
* Transport switching (`stdio` spawn vs `network` WebSocket/HTTP stream).
* `initialize` + `session/new` (`cwd: scratchDir`, `mcpServers: []`, `mode: "ask"`).
* Appending strict JSON formatting directives to the prompt.
* Streaming collection of `agent_message_chunk` tokens.
* Robust JSON boundary extraction and error reporting.
* Session tracking and `dispose()` teardown.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/acp-client.test.ts` in `shorthand-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/acp-client.ts test/acp-client.test.ts
git commit -m "feat(agent): implement AcpAgentClient"
```

---

### Task 5: Export ACP Public Surface and Verify Core Gates

**Files:**
- Modify: `shorthand-core/src/index.ts`

**Interfaces:**
- Produces: `AcpAgentClient`, `detectCursorExecutable`, `listAcpModels`, and types exported from `shorthand-core`.

- [ ] **Step 1: Add exports to `shorthand-core/src/index.ts`**

Export:
```typescript
export { listAcpModels } from "./agent/acp-catalog.js";
export type { ListAcpModelsOptions } from "./agent/acp-catalog.js";
export { AcpAgentClient, detectCursorExecutable } from "./agent/acp-client.js";
export type { AcpAgentClientOptions, AcpTransportConfig } from "./agent/acp-client.js";
```

- [ ] **Step 2: Run typecheck and full test suites**

Run in `shorthand-core`:
```bash
bun test
bun run typecheck
bun run build
bun run test:e2e
```
Expected: All 4 gates pass with 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export ACP agent client and catalog APIs"
```

---

### Task 6: Tag and Publish `shorthand-core` Release

**Files:**
- None (git tag and push)

- [ ] **Step 1: Check git log and git status in `shorthand-core`**

Run: `git status`
Expected: Clean working tree.

- [ ] **Step 2: Tag minor release (0.20.0)**

```bash
git tag -a 0.20.0 -m "0.20.0 — add ACP agent backend support"
git push origin main
git push origin 0.20.0
```

---

### Task 7: Update `shorthand-obsidian-plugin` Settings and Dependency Pin

**Files:**
- Modify: `shorthand-obsidian-plugin/package.json`
- Modify: `shorthand-obsidian-plugin/src/settings.ts`
- Modify: `shorthand-obsidian-plugin/test/plugin-settings.test.ts`

- [ ] **Step 1: Bump `shorthand-core` pin in `package.json` and run `npm install`**

Pin `"shorthand-core": "github:mshish/shorthand-core#0.20.0"` in `package.json`.
Run: `npm install "shorthand-core@github:mshish/shorthand-core#0.20.0"`

- [ ] **Step 2: Update `src/settings.ts`**

* Add `"acp"` to `ENHANCEMENT_BACKENDS`.
* Add `acpTransport`, `acpExecutable`, `acpArgs`, `acpNetworkUrl`, `acpAuthToken`, `acpModel` to `ShorthandPluginSettings` and `DEFAULT_PLUGIN_SETTINGS`.
* Update `normalizePluginSettings` to sanitize all ACP settings.

- [ ] **Step 3: Update `test/plugin-settings.test.ts`**

Add tests verifying `"acp"` backend normalization and defaults.

- [ ] **Step 4: Run tests in `shorthand-obsidian-plugin`**

Run: `bun test test/plugin-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/settings.ts test/plugin-settings.test.ts
git commit -m "feat(settings): add ACP agent backend options"
```

---

### Task 8: Wire ACP in Obsidian Plugin (`main.ts` & Settings Tab)

**Files:**
- Modify: `shorthand-obsidian-plugin/main.ts`
- Modify: `shorthand-obsidian-plugin/src/settings-display.ts`
- Modify: `shorthand-obsidian-plugin/test/plugin-bundle.test.ts`

- [ ] **Step 1: Wire `createEnhanceRunner` in `main.ts`**

Add `else if (backend === "acp")` branch:
* Resolves executable via `detectCursorExecutable`.
* Instantiates `AcpAgentClient`.

- [ ] **Step 2: Add ACP section to Settings UI in `main.ts` / `settings-display.ts`**

* Add `"acp": "Cursor / ACP Agent"` in the backend dropdown.
* Render ACP controls (transport selector, dynamic model dropdown with `listAcpModels`, advanced command & network URL overrides).

- [ ] **Step 3: Run full verification gates in `shorthand-obsidian-plugin`**

Run in `shorthand-obsidian-plugin`:
```bash
npm test
npx tsc --noEmit
npm run build
```
Expected: All gates pass.

- [ ] **Step 4: Commit**

```bash
git add main.ts src/settings-display.ts test/plugin-bundle.test.ts
git commit -m "feat(ui): wire ACP agent backend and settings controls"
```

---

### Task 9: Live End-to-End Verification & Pull Request

**Files:**
- End-to-end live test

- [ ] **Step 1: Run live capture test with Cursor CLI**

Exercise a live enhancement pass using the installed Cursor `agent acp`.

- [ ] **Step 2: Push plugin branch and open PR**

Push commits and open PR for `shorthand-obsidian-plugin`.
