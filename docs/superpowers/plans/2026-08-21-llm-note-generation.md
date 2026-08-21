# LLM Note Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second enhancement backend that generates note sections through ordinary LLM provider APIs — OpenAI, Anthropic, Ollama, and any OpenAI-compatible endpoint — as a user-selectable alternative to the default Claude Agent SDK. The Claude Agent SDK remains the default and loses nothing.

**Architecture:** The seam already exists and is already public. `AgentClient` (`src/agent/contract.ts:127-129`) is transport-neutral and exported from `src/index.ts:55-60`; `ExecutableAgentStub` already proves it is substitutable. This plan adds a second implementation, `LlmAgentClient`, and changes nothing about `EnhanceRunner`'s scheduling, `queryForSections`' retry loop, `NoteSink`, the section schema, or `validateSectionOutput`. Credentials follow the established one-writer credentials-file convention rather than entering the vault. The new backend is tick-tier only: it declares that it cannot drive vault tools, and the runner honours that declaration.

**Tech Stack:** TypeScript (NodeNext, `strict`, `exactOptionalPropertyTypes`), Bun (runtime + `bun:test`), zod 4, Vercel AI SDK 7, esbuild.

**Spec:** none. This plan is self-contained; the decision record is in "Decisions" below.

---

## Global Constraints

- Working directory for core work: `D:\tools\shorthand-repos\shorthand-core`. For plugin work: `D:\tools\obsidian-shorthand`.
- Commands must work in both Git Bash and PowerShell on Windows. No POSIX-only shell tricks.
- Core's gate is all four of `bun test`, `bun run typecheck`, `bun run build`, `bun run test:e2e`. **`bun test` transpiles without typechecking**, so a green suite is not evidence `tsc` is happy — run `bun run typecheck` in every task that changes a type.
- Match existing code style: `#private` class fields, `readonly` / `Readonly<{...}>` types, named exports only, `.js` extensions on relative imports, no `any`.
- Comments explain **why** a thing exists, naming the failure it prevents. Never restate the code. Record the actual reason, not a proxy for it.
- Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`); the body says *why*.
- **Cross-repo ordering is not negotiable** (`AGENTS.md`): land core → push → tag → bump the plugin's pin as the *first* step of plugin work. No junctions, no `overrides`, no `file:` deps. Phase B exists solely to enforce this.
- `MAX_SECTIONS = 50`, `MAX_HEADING_CHARACTERS = 200`, `MAX_MARKDOWN_CHARACTERS = 100_000`, `MAX_TOTAL_SECTION_CHARACTERS = 40_000` are unchanged and continue to be enforced by `validateSectionOutput` for **both** backends.
- Out of scope, do not touch: `EnhanceRunner` scheduling/requeue/timeout behaviour, `buildPassPrompt`'s wording beyond what Task 5 requires, `MarkdownNoteSink`, `NoteSink`, the Google Docs sink, `docs/original-plan.md`, and the `shorthand-config` app (see "Deferred").

---

## Decisions, and what they cost

Each of these was an open question during research. They are settled; do not relitigate them mid-implementation without saying so.

### D1. Vercel AI SDK, using `Output.object()`

The AI SDK is the ecosystem's standard path (18.5M weekly downloads, Vercel-backed, zod-first, one API across providers, `fetch` injection on every provider factory).

**It preserves the enforcement invariant.** `AGENTS.md` requires that output shape "is not defended by prose" but by provider-level schema enforcement. `generateObject` is deprecated in favour of `generateText({ output: Output.object(...) })`, and that replacement keeps provider-level enforcement — verified against the shipped `ai@7.0.74`, not inferred:

```js
// node_modules/ai/dist/index.js — Output.object()
responseFormat: resolve(schema.jsonSchema).then((jsonSchema2) => ({
  type: "json", schema: jsonSchema2, ...
}))
```

and `generateText` forwards it to the model unchanged (`dist/index.js:8410`, `responseFormat: await output?.responseFormat`), where each provider translates it — OpenAI to `response_format: { type: "json_schema" }`, Anthropic to `output_config.format`. `Output.text()` sets `type: "text"` by contrast, which is what makes the distinction legible in the source.

**A note on [vercel/ai#12491](https://github.com/vercel/ai/issues/12491),** which appears to say the opposite and which an earlier draft of this plan relied on. Its opening claim — that `Output.object()` "parses free-form text client-side instead" — was **retracted by the reporter**, who closed it:

> We tested it internally and it turned out the issue was related to using GPT OSS models via Groq that weren't properly following the JSON schema. Switching models resolved it.

Do not re-derive a design from that issue's title. The source above is the authority.

**`AGENTS.md`'s enforcement claim therefore stands and needs no amendment.** What it does need is a second sentence naming the mechanism per backend, since the option is called `outputFormat` in the Agent SDK and `responseFormat` here.

**What genuinely does differ, and what the plan must handle:**

1. **Failure arrives as a throw, not a value.** `Output.object()` raises `NoObjectGeneratedError` when the response cannot be parsed or validated. `queryForSections` breaks out of its retry loop on any thrown error (`src/agent/contract.ts:207-213`), so an uncaught throw would skip the corrective second attempt that `ClaudeAgentClient` deliberately preserves by returning `structuredOutput: undefined` instead (`src/agent/client.ts:35`). Task 4 must convert it the same way.
2. **Enforcement is only as good as the endpoint.** A weak local model, or an OpenAI-compatible endpoint that ignores `response_format`, degrades to best-effort — which is exactly what bit the reporter of #12491. This is a real caveat for Ollama and for arbitrary compatible endpoints, and belongs in the docs, but it is not a property of the AI SDK.

### D2. Credentials live in core's config directory, never the vault

`llm-credentials.json` in `shorthandConfigDirectory()` (`src/config.ts:51-60`), following `google-credentials.json` exactly: **core reads it and never writes it**, the consumer is the sole writer, and `shorthand-core/testing` exports an executable conformance suite the writer must satisfy.

The alternative — an Obsidian settings field — was rejected because `data.json` is plaintext and syncs with the vault, so a key would land on every synced machine and in every vault backup.

Provider, model and base URL live in the **same file** as the key, not a sibling, for the reason `file-token-provider.ts:9-24` already records for `document_id`: two files with one owner and one write moment means a torn state between them.

**The file is therefore the whole connection profile, and `data.json` persists only `backend`.** Anything else duplicates the same tuple across two stores with two writers — precisely the torn state the paragraph above rejects. The settings tab is an *editor* over the external profile, not its owner; a value being displayed in Obsidian does not oblige Obsidian to persist it. The tab's description names the file's location so the user knows where their key actually lives.

### D3. Tick tier only, declared by the client

The LLM backend does not drive `Read`/`Glob`/`Grep`. It works purely from the bounded prompt: current sections, transcript delta, user notes.

**This is a real capability difference and must be documented as one.** Today in Obsidian every pass runs the `link` tier — the plugin passes `vaultRoot`, `MarkdownNoteSink` turns that into `agentContext` (`markdown-sink.ts:75`), and `runner.ts:186` promotes the pass. The model is told *"You may use Read, Glob, and Grep to find relevant people, projects, and prior meetings in the vault."* Notes produced by the LLM backend will not reference people, projects or prior meetings found elsewhere in the vault.

**Mechanism:** an optional `supportsVaultTools` capability on `AgentClient`, read by the runner. The tempting alternative — have the plugin omit `vaultRoot` when the LLM backend is selected — was rejected because `vaultRoot` feeds nothing but `agentContext` (verified: it appears at `markdown-sink.ts:33` and `:75` only), so that knowledge would have to be re-derived correctly in every consumer, and a consumer that forgot would silently ship `tools: ["Read","Glob","Grep"]` to a client that cannot honour them. Declaring it on the client puts it in one place and makes `--tier link --backend llm` behave sanely on the CLI for free.

### D4. Conversation history is ours to hold

The AI SDK is stateless — there is no `resume`. `LlmAgentClient` keeps a `ModelMessage[]` per instance and resends it, which is a genuine continued conversation.

This is not a downgrade. Core already treats the session as **memory, not state**: `DESIGN.md:142-163` records that full sections and the transcript delta are resent every pass regardless, and `ENHANCEMENT_SAFETY_PREAMBLE` tells the model the given sections win over its memory. What we gain by owning the array is an explicit trim policy, where the Agent SDK's `resume` delegates to the `claude` CLI's own store and grows into an auto-compaction path `DESIGN.md:151-163` admits is untested.

Anthropic prompt caching (`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` on message parts) keeps the resend cheap; OpenAI caches prefixes automatically.

### D5. Node floor moves to 22 for this path

`ai@7`, `@ai-sdk/openai@4`, `@ai-sdk/anthropic@4` and `@ai-sdk/provider-utils@5` all declare `engines: { node: ">=22" }`. Core's README currently says "Node.js 20 or Bun" and `bun run build` targets `node20`.

Obsidian is unaffected — its Electron bundles Node 24. The headless CLI is the exposed surface. Task 8 raises the documented floor and the esbuild target to `node22`, and says why.

### D7. Every limit on this path is a loop breaker, set clear of legitimate use

`fc9d11d` ("raise the turn cap clear of legitimate vault exploration") is the precedent and the warning. `maxTurns: 6` was a budget sized near normal use; under a structured output format a tripped cap returns `error_max_turns` with **no structured output at all**, so the pass lost its work outright rather than degrading. It became 75 and was reclassified as a loop breaker.

Apply that reading to every bound the LLM backend touches. Sort them by what happens when they trip:

**Loses the pass's work — must be liberal:**

- **`timeoutMs`, and it gets two values, not one.** 45s (`config.ts:88`) is tuned for a hosted frontier model doing a quick tick. It is tight for link-tier vault exploration and hopeless for a local Ollama model generating 10k tokens of JSON — and a pass that always times out requeues forever, so the note silently stops updating. The new defaults:

  | Context | Value | Why |
  | --- | --- | --- |
  | Live, during the meeting | **120_000** (2 min) | A pass still has to keep up with a meeting in progress, so this stays bounded — but 45s was cutting off work that would have landed. |
  | Standalone / closing enhance | **300_000** (5 min) | Nothing is waiting on it. A final pass over a whole meeting is the most expensive one there is, and it is the one whose loss hurts most. |

  The runner does not choose between them — it takes the `timeoutMs` it is handed (`runner.ts:91`, `:239`). The **callers** choose: live capture passes the first, the one-shot `enhance` path passes the second.

  **This changes the default backend too, deliberately.** These are core-wide values, so the Claude Agent SDK path gets the same relief. That is the intent — 45s was the wrong number for both.

- **`maxAttempts`** stays at 2. It is a correction loop, not a limit that trips.

**Deliberately not introduced: `maxOutputTokens`.** An earlier draft required setting it explicitly, on the theory that a truncated completion is invalid JSON rather than a short answer. That reasoning is sound but the safeguard is unnecessary: `@ai-sdk/anthropic` already derives `max_tokens` per model and fills it in (`dist/index.js:3897`), and the OpenAI-shaped providers leave the completion unbounded by default rather than clipping it low. Adding our own ceiling would mostly create a second number to keep in sync with model capabilities that change without us. The one residual: for a model id the Anthropic provider does not recognise it clamps to a conservative limit and emits a warning (`dist/index.js:3783-3787`) — surface that warning rather than swallowing it, so an exotic model id explains itself.

**Degrades rather than loses — may be tight:**

- **`maxHistoryCharacters`.** Trimming drops accumulated memory only; the current pass still carries full sections and the transcript delta, and `ENHANCEMENT_SAFETY_PREAMBLE` makes the given sections authoritative over the model's recollection (`DESIGN.md:142-163`). Worst case is thinner continuity, never lost work. This is why it can be a real budget where the others cannot.

**Does not apply:**

- **`maxTurns`.** The LLM backend runs no tool loop — one request, one answer (D3). `request.maxTurns` is ignored, and the client should say so in a comment rather than passing it somewhere it would silently mean something else.

The general rule, stated so it survives the next limit someone adds: **a bound whose breach discards a completed pass must sit far above legitimate use; only a bound that degrades gracefully may sit near it.**

### D6. Secret hygiene, deliberately small

The realistic exposure here is accidental — vault sync, backups, a screen share — not an attacker with local code execution. Two cheap defences are warranted and a third is not:

1. **Keep the file out of the vault** (D2). This is the one that matters, because it removes the copy that would otherwise ride vault sync to every machine.
2. **Scrub the exact configured key** from provider error messages and `NoObjectGeneratedError` diagnostics at the `LlmAgentClient` boundary. This path is real: core interpolates `error.message` into a status (`contract.ts:207`, `runner.ts:250`), the plugin puts it in a `Notice` and `console.error` (`main.ts:678-682`), and a provider SDK that echoes config into an error would carry the key the whole way. One exact-string replacement at the single boundary that knows the key, tested on both paths.
3. **Not** general redaction machinery — no recursive error/header sanitisers, no console interception, no stack-trace filtering. Stack traces are not an independent leak here: every path extracts `.message`, not `.stack` (`runner.ts:473`, plugin `main.ts:965`).

The key never enters `AgentQueryRequest` — that type carries no credentials today and must not start. Credentials reach the provider factory through the client constructor only.

---

## Already-verified facts (do not re-derive; re-confirm only where a step says to)

Established during research on 2026-08-21. The plan is built on them.

1. **`AgentClient` is already public.** `src/index.ts:55-60` exports `AgentClient`, `AgentQueryRequest`, `AgentQueryResponse`, `AgentTier`. `docs/CONTRACT.md:27` lists it. No export-map widening is needed for the port itself.
2. **The Agent SDK is not used as a file editor.** `DESIGN.md:119-121`: "The agent has no write tool. `options.tools` never contains `Write`/`Edit`/`Bash`". The only mutation path is `sink.write()` in `runner.ts:267`. A chat-completions backend therefore substitutes without reimplementing any write path.
3. **`src/agent/client.ts` is the only file importing `@anthropic-ai/claude-agent-sdk`.** The new backend must keep that true for its own SDK — put every `ai` / `@ai-sdk/*` import in one new file, so `mock.module` in one test file cannot disturb another suite.
4. **`vaultRoot` feeds only `agentContext`** — `markdown-sink.ts:33` and `:75`, nowhere else.
5. **Everything requests the `link` tier.** `enhanceNow(tier: AgentTier = "link")` (`runner.ts:143`); `bin/shorthand-notes.ts:403,410` pass `"link"` explicitly. The `tick` tier is reached only via the Google Docs sink (no `agentContext`) or `--tier tick`.
6. **Package versions, checked against the registry on 2026-08-21:** `ai@7.0.74`, `@ai-sdk/openai@4.0.45`, `@ai-sdk/anthropic@4.0.40`, `@ai-sdk/openai-compatible@3.0.34`, all Apache-2.0, all `engines.node >=22`.
7. **zod peer range is `^3.25.76 || ^4.1.8`.** Core currently pins `zod ^4.1.5`, which is **below** the peer floor. Task 1 bumps it.
8. **`@ai-sdk/provider-utils@5.0.28` depends on `undici@^7.28.0`** plus `@workflow/serde` and `eventsource-parser`. `undici` reaches for Node built-ins. Task 1 contains a bundling spike that must pass before any other task starts.
9. **`generateText` accepts `messages`** (`SystemModelMessage` / `UserModelMessage` / `AssistantModelMessage` / `ToolModelMessage`) as an alternative to `prompt`, but the result has **no `response.messages` helper** — the assistant turn must be constructed by hand before being appended to history.
10. **`Output.object()` requests provider-native structured output.** Verified by reading the shipped `ai@7.0.74`: `Output.object()` builds `responseFormat: { type: "json", schema }` and `generateText` forwards it to `doStream`/`doGenerate` (`dist/index.js:8410`). `Output.text()` sets `type: "text"`. Re-verify this with `grep -n "responseFormat" node_modules/ai/dist/index.js` after any `ai` major bump — it is the load-bearing fact behind D1.
11. **`Output.object()` throws `NoObjectGeneratedError`** on parse/validation failure rather than returning a sentinel; the throw site is in `parseCompleteOutput` in the same file.
12. **The plugin's bundle-size test no longer gates.** It reports drift and warns; it does not fail. Library weight is a judgment call here, not a build breaker.

---

## File Structure

### `shorthand-core`

| File | Responsibility |
| --- | --- |
| `src/agent/llm-client.ts` | **New.** `LlmAgentClient` — the only file importing `ai` / `@ai-sdk/*`. Builds the provider, holds `ModelMessage[]`, calls `generateText({ output: Output.object(...) })`, returns `AgentQueryResponse`. |
| `src/agent/llm-credentials.ts` | **New.** `LlmCredentials` type, `llmCredentialsPath()`, `readLlmCredentials()`. Reads only; never throws. |
| `src/agent/contract.ts` | `AgentClient` gains optional `supportsVaultTools`. Nothing else changes. |
| `src/agent/runner.ts` | One line: tier selection also consults the client's capability. |
| `src/index.ts` | Adds `LlmAgentClient`, its options type, the credentials reader and its types to the explicit export list. |
| `src/testing/llm-credentials-conformance.ts` | **New.** The executable contract the credentials writer must satisfy. |
| `src/testing/index.ts` | Re-exports the new conformance suite. |
| `bin/shorthand-notes.ts` | `--backend claude\|llm` flag; constructs the chosen client. |
| `package.json` | Adds four `ai` packages; bumps `zod` floor; esbuild target and externals. |
| `docs/DESIGN.md`, `docs/CONTRACT.md`, `AGENTS.md`, `README.md` | The amended enforcement claim, the new public surface, the tier gap, the Node floor. |

### `obsidian-shorthand`

| File | Responsibility |
| --- | --- |
| `src/settings.ts` | The `backend` discriminator and its normalisation. Nothing else — the connection profile lives in the credentials file (D2). |
| `src/llm-credentials-writer.ts` | **New.** The sole writer of `llm-credentials.json`. Lives outside `main.ts` so it is testable under `bun test`. |
| `main.ts` | `createEnhancer()` branches on backend; settings tab gains the new controls. |
| `test/plugin-settings.test.ts` | Normalisation tests for the new fields. |
| `test/llm-credentials-conformance.test.ts` | **New.** Runs core's exported conformance suite against the plugin's writer. |
| `README.md` | Prose block for backend choice; corrects the "claude CLI required" framing. |

---

# Phase A — core

### Task 1: Dependency spike, then land the dependencies

**This task gates every other task.** Fact 8 is an unverified risk until the spike runs: if `undici` cannot be bundled by the plugin's esbuild config, D1 collapses and the runner-up (direct `openai` + `@anthropic-ai/sdk`) has to be reconsidered before any code is written against the AI SDK.

**Files:** `package.json`

- [ ] **Step 1: Spike the bundle before committing to the library**

In a scratch directory outside both repos, install `ai@7.0.74`, `@ai-sdk/openai@4.0.45`, `@ai-sdk/anthropic@4.0.40`, `@ai-sdk/openai-compatible@3.0.34`, write a module that imports and constructs each provider and calls `generateText` with `Output.object()`, and bundle it with **the plugin's real esbuild config, unmodified** — `platform: "node"`, `format: "cjs"`, **`target: "node18"`** (`obsidian-shorthand/esbuild.config.mjs:61`), `external: ["obsidian", "electron", ...builtins]`.

**Spike `node18`, not `node22`.** Task 8 decides to leave the plugin's target alone; a spike run against a target the plugin does not ship proves nothing about what ships. If `node18` is what goes to users, `node18` is what must be shown to bundle.

Record: does it bundle; does the output `require()` cleanly under Node; what is the size delta. Write the findings into this plan under Task 1 before proceeding.

**Stop and report if the bundle fails.** Do not work around it silently — a workaround invented here would outlive the constraint that prompted it.

**Spike findings (2026-08-21, scratch dir `D:\tools\ai-sdk-spike`, deleted after recording):**

- **Bundles cleanly.** `esbuild@0.25.9` (pinned to match the plugin's own `esbuild` version) with the plugin's exact production config — `bundle: true`, `platform: "node"`, `target: "node18"`, `format: "cjs"`, `treeShaking: true`, `sourcemap: "inline"`, the `import.meta.url` define/banner pair, `external: ["obsidian", "electron", ...nodeBuiltins]` — bundled a module that imports `createOpenAI`, `createAnthropic`, `createOpenAICompatible`, and `generateText`/`Output`/`jsonSchema` from `ai@7.0.74`, `@ai-sdk/openai@4.0.45`, `@ai-sdk/anthropic@4.0.40`, `@ai-sdk/openai-compatible@3.0.34` with `zod@^4.1.8`. Exit code 0, zero esbuild warnings.
- **`undici` does not block bundling — fact 8's risk did not materialize.** `@ai-sdk/provider-utils` depends on `undici@^7.28.0`, but nothing in `ai`/`@ai-sdk/*` does a static `import`/`require("undici")`. The only reference (`node_modules/ai/dist/index.js`, function `createSafeNodeFetch`) is `createRequire(getCurrentModulePath())("undici")` — a dynamic call esbuild cannot statically resolve, so it leaves it as a runtime `require` rather than trying to bundle undici's implementation. That path is reached only inside `getDefaultDownloadFetch()`, guarded by `isNodeRuntime()` and `isNodeDefaultFetch(globalThis.fetch)`, i.e. only when running under real (non-Bun) Node with the untouched global fetch. **This is a latent runtime risk, not a bundling risk**, worth flagging for whichever later task decides on the `fetch` override (plan mentions Task 14's "wrap Obsidian's `requestUrl`" question): if that codepath ever executes inside the bundled plugin, it will attempt a real `require("undici")` resolved relative to the bundle file, and the plugin ships no `node_modules` for that to resolve against. Overriding `fetch` in `LlmAgentClient` (or simply not being the "default node fetch" scenario) sidesteps it; it does not need solving in Task 1.
- **`require()` of the bundle works cleanly.** `node -e "require('./spike-bundle.js')"` ran the module: all three provider factories (`createOpenAI`, `createAnthropic`, `createOpenAICompatible`) constructed without throwing, and `generateText({ model, prompt, output: Output.object({ schema }) })` was called against all three. Every provider's `baseURL` was pointed at an unroutable local port (`http://127.0.0.1:1/v1`) — no API keys exist, and the sandbox has outbound internet access, so a fake key alone was not sufficient to guarantee no real call went out. All three calls threw `AI_RetryError` wrapping `AI_APICallError: Cannot connect to API: bad port` — a clean connection-layer failure, not a bundle- or construction-level crash. This is the expected, acceptable failure mode the brief specifies.
- **Size delta.** Baseline bundle (same esbuild config, no AI SDK imports): 802 bytes. Spike bundle (with all three providers + `ai` + `zod` + transitive deps): 7,138,500 bytes. **Delta ≈ 7,137,698 bytes (~6.8 MB / 6.81 MiB)** added by the AI SDK dependency tree. Largest contributors per `esbuild --metafile` analysis: `@ai-sdk/openai` (379.1kb), `@ai-sdk/anthropic` (268.2kb), `ai` (198.0kb), `@ai-sdk/gateway` (103.6kb), `@ai-sdk/provider-utils` (100.3kb), and zod's bundled locale files (`zod/v4/locales/*.js`, dozens of files, several KB each, summing to a large fraction of the total — zod ships all locales unconditionally and esbuild's tree-shaking does not eliminate them). Against the plugin's current `main.js` baseline of 6,985,538 bytes, this addition would roughly **double** the plugin bundle size, to roughly 14.1 MB.
- **Fact 10 re-verified against the actual shipped `ai@7.0.74`.** `grep -n "responseFormat" node_modules/ai/dist/index.js` confirms `Output.object()` builds a provider-level `responseFormat`, not client-side text parsing:
  ```
  3544:    responseFormat: resolve(schema.jsonSchema).then((jsonSchema2) => ({
  3545:      type: "json",
  3546:      schema: jsonSchema2,
  ```
  and `generateText`'s call into `doStream` forwards it unchanged:
  ```
  8410:      responseFormat: await (output == null ? void 0 : output.responseFormat),
  ```
  (also forwarded identically at line 5649 in the streaming path). `Output.text()` by contrast sets `responseFormat: Promise.resolve({ type: "text" })` (line 3525) — the distinction the plan's D1 relies on to say enforcement is provider-level, not prose-defended.
- **`generateText`'s return shape when `output` is supplied: `result.output`.** `DefaultGenerateTextResult` (node_modules/ai/dist/index.js:6123-6129) stores `this._output = options.output` in its constructor; the class exposes it via a getter (`:6199-6204`):
  ```
  get output() {
    if (this._output == null) {
      throw new NoOutputGeneratedError();
    }
    return this._output;
  }
  ```
  `options.output` is populated (`:6058-6069`) by `await outputSpecification.parseCompleteOutput({ text: lastStep.text }, {...})` only when `lastStep.finishReason === "stop"`. For `Output.object()`, `parseCompleteOutput` (`:3550-3577`) JSON-parses the model's text, validates it against the schema, and returns `validationResult.value` — the parsed, validated structured object — or throws `NoObjectGeneratedError` if parsing or validation fails. So the structured value arrives at `result.output`, not `result.text` or `result.experimental_output`; a later task (`LlmAgentClient`) should read `result.output` and treat both `NoObjectGeneratedError` and `NoOutputGeneratedError` as the "no structured output" case it needs to convert to `structuredOutput: undefined`, matching `ClaudeAgentClient`'s existing behaviour.

**Conclusion: the spike passes. D1 stands; nothing here blocks Step 2.** The one actionable follow-up (the dynamic `undici` require under Electron) is noted above for the task that decides the `fetch` override, not for Task 1 to resolve.

- [ ] **Step 2: Add the dependencies**

```json
"ai": "^7.0.74",
"@ai-sdk/openai": "^4.0.45",
"@ai-sdk/anthropic": "^4.0.40",
"@ai-sdk/openai-compatible": "^3.0.34",
"zod": "^4.1.8"
```

The `zod` bump is not cosmetic: `^4.1.5` sits below the `^4.1.8` peer floor (fact 7), so npm would warn and the resolved zod could differ between core's checkout and the plugin's.

Add the four packages to the esbuild `--external:` list in the `build` script, matching how `@anthropic-ai/claude-agent-sdk` is already externalised — the CLI resolves them from `node_modules` at runtime.

- [ ] **Step 3: Verify** — `bun install`, `bun run typecheck`, `bun test`, `bun run build`, `bun run test:e2e`. All four green with no behaviour change yet.

---

### Task 2: The credentials reader

Mirrors `src/google/file-token-provider.ts` deliberately. Read it first; this file should look like its sibling.

**Files:** create `src/agent/llm-credentials.ts`; test `test/llm-credentials.test.ts`

**Interfaces produced:**

```ts
export type LlmProviderId = "openai" | "anthropic" | "openai-compatible";

export type LlmCredentials = Readonly<{
  provider: LlmProviderId;
  model: string;
  api_key?: string;   // absent is legitimate: local Ollama needs none
  base_url?: string;  // required for openai-compatible, optional elsewhere
}>;

export type LlmCredentialsReadResult =
  | Readonly<{ ok: true; value: LlmCredentials }>
  | Readonly<{ ok: false; message: string }>;

export function llmCredentialsPath(environment?: NodeJS.ProcessEnv): string;
export function readLlmCredentials(path?: string): Promise<LlmCredentialsReadResult>;
```

- [ ] **Step 1: Write the failing tests**

Cover, at minimum: missing file reports the path and a remedy; non-JSON reports so; a non-object reports so; an unknown `provider` is rejected by name; an empty `model` is rejected; `openai-compatible` without `base_url` is rejected *because the endpoint is unknowable without it*; a valid file round-trips.

**`api_key` is optional for every provider at read time**, including `openai` and `anthropic`. This is not laxness: it is what lets "clear my key" preserve the rest of the profile instead of writing a file the reader then rejects wholesale. A key that is genuinely required-and-absent is caught where the requirement actually lives — constructing the OpenAI or Anthropic client (Task 4) — with a message saying so. Test both halves: the file parses, and the client construction refuses.

Every one of these asserts on the returned message, not just `ok: false`. The writer is a different program; a malformed file is ordinary input and the message is the entire user-facing remedy.

- [ ] **Step 2: Implement**

`readLlmCredentials` **never throws** — same contract, same reason as `readCredentials`: an exception here surfaces mid-capture as a crash instead of a message telling the user what to do.

Write the file-header comment in the shape of `file-token-provider.ts:9-24`: state that core does not write this file, that there is deliberately no function here that does, and that the conformance suite is the executable form of the contract.

- [ ] **Step 3: Verify** — `bun test test/llm-credentials.test.ts`, then `bun run typecheck`.

---

### Task 3: The capability flag and tier selection

Smallest change in the plan, and the one that keeps a whole class of consumer bug impossible.

**Files:** modify `src/agent/contract.ts:127-129`, `src/agent/runner.ts:186`; test `test/enhance-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/enhance-runner.test.ts`, using the existing `FakeAgent`:
- a client with `supportsVaultTools: false` and a sink that *does* expose `agentContext` runs the **tick** tier: the emitted status names `tick`, the request carries `tools: []` and **no `cwd`**, and the prompt contains the tick vault instruction.
- a client leaving `supportsVaultTools` undefined behaves exactly as today (link tier when `agentContext` exists) — this is the regression guard for `ClaudeAgentClient` and `ExecutableAgentStub`.

- [ ] **Step 2: Implement**

```ts
export interface AgentClient {
  /**
   * Whether this client can honour `tools`. Absent means yes, so every client
   * written before this flag existed keeps its behaviour.
   *
   * The runner consults it rather than trusting the sink alone, because
   * `agentContext` describes what the *note* can offer, not what the *client*
   * can do. A client that cannot drive Read/Glob/Grep and is handed them anyway
   * produces a prompt promising vault lookups it will never perform.
   */
  readonly supportsVaultTools?: boolean;
  query(request: AgentQueryRequest): Promise<AgentQueryResponse>;
}
```

`runner.ts:186` becomes:

```ts
const toolsUsable = this.#options.agent.supportsVaultTools !== false;
const tier: AgentTier =
  requestedTier === "link" && agentContext !== undefined && toolsUsable ? "link" : "tick";
```

`!== false`, not truthiness — `undefined` must mean "yes" (fact: `ClaudeAgentClient` does not set it).

**`cwd` must move with the tier.** `runner.ts:219` currently sets `cwd` whenever the sink has an `agentContext`, independent of tier, so the capability flag alone would still hand a vault path to a client that cannot use it:

```ts
...(agentContext === undefined || tier !== "link" ? {} : { cwd: agentContext.cwd }),
```

This also changes the *existing* tick path, deliberately and in the safe direction: `buildClaudeAgentOptions` picks its guard on `cwd` alone (`client.ts:70`), so dropping `cwd` on a tick swaps `createVaultToolGuard` for `denyAllToolGuard`. With `tools: []` already in force nothing was reachable either way, so this tightens a belt that was never load-bearing rather than changing behaviour. `test/enhance-runner.test.ts:39` asserts the old shape and must be updated deliberately.

- [ ] **Step 3: Verify** — `bun test`, `bun run typecheck`. The whole existing suite must stay green; any red test here means the default changed, which it must not.

---

### Task 4: `LlmAgentClient`

The substance of the plan. Keep **every** `ai` / `@ai-sdk/*` import in this one file (fact 3).

**Files:** create `src/agent/llm-client.ts`; test `test/llm-client.test.ts`

**Interfaces produced:**

```ts
export type LlmAgentClientOptions = Readonly<{
  credentials: LlmCredentials;
  /** Injection point for Obsidian's requestUrl and for tests. */
  fetch?: typeof globalThis.fetch;
  /** Character budget for retained history. See the trim note below. */
  maxHistoryCharacters?: number;
  /** Per-request bound. The runner also races its own timeout — see D7. */
  timeoutMs?: number;
}>;

export class LlmAgentClient implements AgentClient {
  readonly supportsVaultTools = false;
  constructor(options: LlmAgentClientOptions);
  query(request: AgentQueryRequest): Promise<AgentQueryResponse>;
}
```

- [ ] **Step 1: Write the failing tests**

Mock the `ai` module with `mock.module`, as `test/agent-client-query.test.ts` already does for the Agent SDK — **and mock the three `@ai-sdk/*` provider factories separately**, since provider selection, API-key and base-URL propagation and the injected `fetch` all happen there rather than in `ai`. Assert:

- `request.systemPrompt` is sent **verbatim and unmodified** as the leading system message. This is the load-bearing one: `ENHANCEMENT_SAFETY_PREAMBLE` is composed upstream in `runner.ts:224`, so the backend inherits the injection guard *only* if it forwards the string untouched. Mirror the `GUIDANCE_CASES` `test.each` discipline from `test/enhance-runner.test.ts`.
- `request.outputSchema` (a JSON Schema, already derived from zod by `buildSectionOutputSchema()`) reaches `Output.object`.
- The returned `structuredOutput` is whatever the model produced, passed through untouched for `validateSectionOutput` to judge. **The client does not validate sections.** Two gates in two places is how one of them ends up subtly weaker.
- History accumulates: a second `query()` on the same instance sends the first turn's user message *and* an assistant message, then the new user message.
- `request.signal` aborts an in-flight call.
- A **`NoObjectGeneratedError` is converted, not propagated**: `query()` resolves with `structuredOutput: undefined` and the error text in `diagnostics`. This is the single most important test in the task. `queryForSections` breaks its retry loop on any thrown error (`src/agent/contract.ts:207-213`), so letting this one escape silently costs the corrective second attempt — the same reason `ClaudeAgentClient` converts schema-retry exhaustion at `src/agent/client.ts:35`. Assert the retry actually happens by driving `queryForSections` with a client that fails once and then succeeds.
- Any **other** provider error becomes a thrown error whose message names the provider and the model, so `queryForSections` reports something a user can act on — **with the configured key scrubbed to `[REDACTED]`** (D6). Test this on both the thrown-error path and the `diagnostics` path, with a key value planted in the provider's error message.
- Neither `maxOutputTokens` nor `request.maxTurns` is forwarded anywhere (D7).
- Provider warnings are surfaced in `diagnostics` rather than dropped — the Anthropic provider emits one when it does not recognise a model id and clamps its token limit.
- Constructing an `openai` or `anthropic` client with no `api_key` fails, since the reader now accepts its absence (Task 2) — and the message must be **actionable, not a label**. Assert on its content, not just that it threw. It must name the provider, name the file the profile came from, and say what to do: something of the form *"No API key for `openai` in `<path>`. Add one in Shorthand's settings, or switch to a provider that does not need one."* `API key required` alone is a dead end for a user who does not know the file exists.
- `supportsVaultTools` is `false`.
- `tools`/`cwd` on the request are ignored rather than silently promised — assert nothing tool-shaped reaches the SDK.

- [ ] **Step 2: Implement**

Provider construction, one factory per `provider` value, each taking the injected `fetch`:

```ts
createOpenAI({ apiKey, ...(baseURL && { baseURL }), fetch })
createAnthropic({ apiKey, ...(baseURL && { baseURL }), fetch })
createOpenAICompatible({ name: "openai-compatible", baseURL, apiKey, fetch })
```

`base_url` is honoured for **all three** providers, not just the compatible one — OpenAI and Anthropic both accept a base URL for gateways, proxies and Azure-style deployments, and a credentials file that accepts the field then silently ignores it for two of three providers is worse than not accepting it. It stays *required* only for `openai-compatible`, where the endpoint is unknowable without it.

The call:

```ts
const { output } = await generateText({
  model: this.#model,
  // jsonSchema() is required, not decorative: Output.object takes a FlexibleSchema
  // (Schema | LazySchema | ZodSchema | StandardSchema) and `outputSchema` arrives as a
  // plain Record<string, unknown> off the transport-neutral port, which is in none of them.
  output: Output.object({ schema: jsonSchema(request.outputSchema) }),
  messages: [...this.#history, userMessage],
  abortSignal: request.signal,
});
```

Catch `NoObjectGeneratedError` around this call and return `{ structuredOutput: undefined, diagnostics: [...] }` rather than letting it propagate — D1, item 1.

Do **not** set `maxOutputTokens` (D7) — the providers derive it, and a second ceiling here would drift from model capabilities we do not control. `request.maxTurns` is deliberately **not** forwarded either: there is no tool loop for it to bound. Comment both absences, so neither gets "fixed" later.

Session id: generate a stable non-empty id per instance, return it, and comment that it identifies *our* history, not a provider-side session, because none exists. **Reject a supplied, non-empty `request.sessionId` that differs from it.** A client instance belongs to one capture — the plugin builds a fresh `EnhanceRunner` per capture (`main.ts:242`, `:450`, `:530`) and refuses a concurrent second one (`main.ts:202`), so this cannot fire in the intended lifecycle. It is a cheap assertion against a consumer wiring one client into two runners, which would splice one meeting's transcript into another's note. Do **not** key history by session id — that builds a cache to solve a problem the instance boundary already solves.

Commit rule for history — **and Step 1 must include a deterministic test for it**, not just a description. Drive the sequence explicitly: start pass A; let it hang; trip the runner's timeout so A is aborted and requeued; start pass B; let B resolve and append; *then* let A resolve. Assert A's pair never enters the history and B's is intact. A concurrency guarantee described but not reproduced is a comment, not a guarantee.

The rule itself is subtler than it looks. Assign a monotonically increasing **generation** at entry, snapshot the history for the call, and append the completed user+assistant pair only if the generation is still current *and* the signal did not abort. The weaker rule "drop the append if a newer pass already appended" does not hold: a timed-out pass can resolve after its replacement has started but before that replacement appends, and would win the race. `#inFlight` serialises ordinary passes (`runner.ts:130`), but a timeout aborts, returns, and keeps tracking the abandoned promise (`runner.ts:238`, `:355`) — that is exactly the window. Append the pair atomically; never a half pair.

History trim: a **character budget**, not a turn count. A turn here can be a 40,000-character section array (`MAX_TOTAL_SECTION_CHARACTERS`) plus a requeued transcript delta, so "8 turns" bounds nothing. Default `maxHistoryCharacters` to 120_000 and drop oldest **user+assistant pairs** — never a half pair — until the retained pairs fit.

**The budget covers retained history pairs only.** The system message and the current pass's user message are excluded from the count and are never evictable, so the rule stays well-defined when the system prompt alone exceeds the budget: history goes to empty and the call still proceeds with system + current. A budget that could evict the system message would silently drop `ENHANCEMENT_SAFETY_PREAMBLE`, which is the one thing that must never happen. Reject non-finite, negative or fractional values at construction rather than at first use. Comment the actual reason: an unbounded array grows every pass for up to `maxDurationMs` (4h), and unlike the Agent SDK there is no auto-compaction behind us.

Anthropic prompt caching: set `providerOptions.anthropic.cacheControl = { type: "ephemeral" }` on the system message part. Note in a comment that the minimum cacheable length is model-dependent (1024–4096 tokens), so this is an optimisation that silently no-ops on short prompts rather than a guarantee.

- [ ] **Step 3: Verify** — `bun test test/llm-client.test.ts`, `bun run typecheck`.

---

### Task 5: The tick-tier prompt tells the truth

`buildPassPrompt`'s tick branch currently reads *"This live tick has no vault tools. Work only from the bounded input below."* That wording assumes tick means *live tick*. For the LLM backend every pass is tick, including the final one.

**Files:** modify `src/agent/runner.ts:431-434`; test `test/enhance-runner.test.ts`

- [ ] **Step 1** — assert the tick instruction no longer claims to be a live tick and still forbids vault lookups.
- [ ] **Step 2** — reword to something true in both cases, e.g. *"You have no vault tools on this pass. Work only from the bounded input below."*
- [ ] **Step 3** — `bun test`, `bun run typecheck`. Check whether any existing test asserts the old string; update it deliberately, not reflexively.

---

### Task 6: The conformance suite for the credentials writer

The executable contract, so the plugin's writer can be proven correct from core rather than by inspection. Model it on `src/testing/google-credentials-conformance.ts` (426 lines) — same primitives, same harness shape.

**Files:** create `src/testing/llm-credentials-conformance.ts`; modify `src/testing/index.ts`; test `test/llm-credentials-conformance.test.ts`

- [ ] **Step 1** — write a self-test that runs the suite against a known-good in-repo fake writer, proving the suite passes something correct.
- [ ] **Step 2** — implement `describeLlmCredentialsConformance(primitives, label, harnessFactory, support)` plus `LLM_CREDENTIALS_FIXTURES`. Scenarios: writes to core's own `llmCredentialsPath()`; output is readable by `readLlmCredentials`; round-trips every provider variant including keyless `openai-compatible`; overwrites rather than merges; leaves no temp-file debris behind; restrictive file permissions where `support.posixPermissions`.

  Match the *strength* of the Google suite, not just its shape: it carries golden-byte fixtures and is itself proven by being run against deliberately broken writers (`src/testing/google-credentials-conformance.ts:349`, `test/google-credentials-conformance.test.ts:117`). A suite that only passes a correct writer has not been shown to fail an incorrect one. Include at least one mutation case per scenario.
- [ ] **Step 3** — re-export from `src/testing/index.ts` with named exports only. Import anything heavy dynamically, for the reason `src/testing/index.ts:6-10` already records: a sink implementer resolves this file too and must not pick up unrelated dependencies.
- [ ] **Step 4** — `bun test`, `bun run typecheck`.

---

### Task 7: Exports and the CLI

**Files:** modify `src/index.ts`, `bin/shorthand-notes.ts`; test `test/cli-*.test.ts` as appropriate

- [ ] **Step 1** — add to `src/index.ts`'s explicit list: `LlmAgentClient`, `type LlmAgentClientOptions`, `readLlmCredentials`, `llmCredentialsPath`, `type LlmCredentials`, `type LlmCredentialsReadResult`, `type LlmProviderId`.
- [ ] **Step 2** — add `--backend claude|llm` to the flag list at `bin/shorthand-notes.ts:51-53`, defaulting to `claude`. On `llm`, read the credentials file and construct `LlmAgentClient`; on a read failure exit with the reader's message verbatim and a non-zero code. Follow the `--sink markdown|google` precedent at `:300-301` for validation shape.

  **Client construction failures surface like credential-read failures, not as exceptions.** `runCli` rethrows anything that is not an argument error, leaving the binary wrapper to format it — so a missing-key throw would print differently from a missing-file error for the same user mistake. Route both through the established `console.error(<message>)` + non-zero return used at `bin/shorthand-notes.ts:156` and `:315`, so the CLI and the plugin say the same thing.

  **Precedence, stated so it is not decided by accident at three call sites:** `--agent-stub` wins over everything, because it exists to make the other backends unreachable in tests. Otherwise `--backend` selects, and `--claude` is an error when combined with `--backend llm` rather than being ignored — a user who passes both has a wrong mental model, and silently honouring one teaches them it worked. `llmCredentialsPath()` takes the injected `environment`, matching `credentialsPath()` and the environment `runCli` already threads through (`bin/shorthand-notes.ts:338`); without it the CLI's own tests cannot redirect the config directory.

- [ ] **Step 2b: CLI regression coverage** — the default path still selects `ClaudeAgentClient`; `--backend llm` and `--backend=llm` both parse; an unknown value is a usage error; a missing and a malformed credentials file each exit non-zero with the reader's message; keyless `openai-compatible` credentials are accepted; `--backend llm --claude <path>` is rejected; and a capture started with `--backend llm` runs the tick tier.
- [ ] **Step 3** — `bun test`, `bun run typecheck`, `bun run build`, `bun run test:e2e`.

---

### Task 8: Node floor

**Files:** `package.json`, `README.md`

- [ ] Raise **core's** esbuild `--target` to `node22` and state the floor in `README.md`'s prerequisites, replacing "Node.js 20 or Bun". Say why in one line: the AI SDK packages declare `engines.node >=22`, so the floor follows a dependency's requirement rather than a preference.
- [ ] **Leave the plugin's `target: "node18"` alone** unless the Task 1 spike shows otherwise. `engines` is advisory metadata npm warns about; it is not a runtime check, and esbuild's `target` governs syntax downlevelling, not API availability. The question the spike actually answers is whether the AI SDK reaches for a Node API newer than the floor Obsidian ships — and Obsidian's Electron bundles a far newer Node than either number. Changing the plugin target on the strength of an `engines` field would be cargo-culting a warning.
- [ ] `bun run build`, `bun run test:e2e`.

---

### Task 8b: Enhancement timeouts

Independent of the LLM work and affects **both** backends (D7). Land it on its own commit so it can be reverted without touching the backend.

**Files:** `src/config.ts`, `src/agent/runner.ts`, `bin/shorthand-notes.ts`; test `test/enhance-runner.test.ts`

- [ ] **Step 1: Write the failing tests** — the runner's default `timeoutMs` is 120_000, not 45_000; a caller-supplied value still wins; the standalone `enhance` path is constructed with 300_000.

- [ ] **Step 2: Implement**

```ts
enhancement: {
  maxDurationMs: 4 * 60 * 60 * 1000,
  timeoutMs: 120_000,           // live passes, during the meeting
  standaloneTimeoutMs: 300_000, // the one-shot enhance; nothing is waiting on it
  maxTurns: 75,
}
```

Fix the drift at `runner.ts:91` while you are here: it hardcodes `?? 45_000` rather than reading `DEFAULT_CONFIG.enhancement.timeoutMs`, so the constant and the fallback can disagree and today's 45s appears in two places. Point the fallback at the constant.

Comment the two values with the reason, not the number: a pass that outlives its timeout is requeued and its work discarded, so the bound has to clear the slowest legitimate pass — which for a local model generating a full section array is minutes, not seconds.

- [ ] **Step 3** — `bin/shorthand-notes.ts:374` keeps `HANDY_NOTES_AGENT_TIMEOUT_MS` as the override but takes `standaloneTimeoutMs` as its default on the `enhance` command; the capture path keeps `timeoutMs`.

- [ ] **Step 4: Verify** — `bun test`, `bun run typecheck`, `bun run build`, `bun run test:e2e`.

---

### Task 9: Docs

**Files:** `AGENTS.md`, `docs/DESIGN.md`, `docs/CONTRACT.md`, `README.md`

- [ ] **`AGENTS.md`** — extend "The enhancement prompt is split, deliberately" by one sentence naming the mechanism per backend: the Claude Agent SDK backend passes `outputFormat: { type: "json_schema" }`, the LLM backend passes `responseFormat: { type: "json", schema }` via `Output.object()`. **Do not weaken the existing claim** — both are provider-level enforcement (D1), and zod remains the second gate for what a schema cannot express. Add the one honest caveat: enforcement depends on the endpoint honouring the schema, which a weak local model may not.
- [ ] **`docs/DESIGN.md`** — document the second backend, the tick-tier capability gap (D3) in the same voice as the existing tier discussion, the credentials file, and our own history array versus `resume` (D4).
- [ ] **`docs/CONTRACT.md`** — add the new exports to the public-surface table at `:27`. Add `LlmAgentClient`'s internals to the "deliberately NOT exported" table if any test seams emerge.
- [ ] **`README.md`** — a backend section; correct the standing claim that the `claude` CLI is required, which is now true only of the default.

---

# Phase B — release

### Task 10: Push and tag

- [ ] All four gates green: `bun test`, `bun run typecheck`, `bun run build`, `bun run test:e2e`.
- [ ] Commit, push, and tag. Minor bump — `AgentClient` gained a member, which is the breaking slot on the `0.x` line even though the member is optional. Annotated, bare, no `v` prefix: `git tag -a 0.9.0 -m "0.9.0 — LLM note-generation backend"`, then `git push origin 0.9.0`.
- [ ] Verify with `git ls-remote --tags origin 0.9.0` and compare `0.9.0^{}`.

**Nothing in Phase C may begin before this tag exists.** The plugin cannot see an untagged core change.

---

# Phase C — the Obsidian plugin

### Task 11: Bump the pin first

- [ ] `npm install "shorthand-core@github:mshish/shorthand-core#0.9.0"`, confirm the lockfile's `resolved` commit actually moved, commit the refreshed lockfile.
- [ ] Delete `main.js` and rebuild before testing — `test/plugin-bundle.test.ts` only builds when absent, so a stale bundle would report the old core's size.
- [ ] `npm test`. Note the reported `[bundle]` percentage; it will jump, and that is expected here.

### Task 12: Settings

All logic in `src/settings.ts`, none in `main.ts` — `main.ts` cannot be imported under `bun test` (no runtime `obsidian` module), so anything placed there is untestable.

- [ ] **Step 1: Write the failing tests** in `test/plugin-settings.test.ts`, following the existing per-field pattern and the "garbage in → default out, never throw" convention.

- [ ] **Step 2: Extend the settings type — by exactly one field**

```ts
backend: "claude-agent-sdk" | "llm";
```

That is the whole change. `provider`, `model`, `base_url` and `api_key` are **not** here: per D2 the credentials file owns the entire connection profile, and adding them would create two writers for one tuple. `saveData()` serialises this object wholesale (`main.ts:197`), so a field placed here is a field in the vault.

`DEFAULT_PLUGIN_SETTINGS.backend = "claude-agent-sdk"`, which is what makes this invisible to existing users. No schema version, no migration routine: this repo's strategy is that every key independently degrades to a safe default, so an old `data.json` lacking `backend` normalises to the current behaviour. Validate it against its literal union with a fallback, next to the existing `stringValue` / `vaultRelativeDirectory` helpers.

**`model` has no default to inherit** — `DEFAULT_CONFIG` has no provider or model (`src/config.ts:62-96`), and baking a model id into a library that outlives it would age badly, since model ids churn faster than releases. Empty is a validation failure reported by the settings tab and by Task 2's reader.

- [ ] **Step 3: Verify** — `npm test`, `npx tsc --noEmit`.

### Task 13: The credentials writer

**Files:** create `src/llm-credentials-writer.ts`; create `test/llm-credentials-conformance.test.ts`

- [ ] **Step 1** — wire core's exported `describeLlmCredentialsConformance` to a harness over the plugin's writer, exactly as `shorthand-config/conformance/run.ts` does for the Google writer. Write this first; it is the specification.
- [ ] **Step 2** — implement the writer: resolve `llmCredentialsPath()` from core, `mkdir -p` the directory, then write to a temp file **in the same directory** and `rename` it over the target. Rename-within-a-directory is the cheap part of atomicity that actually pays here: a crash mid-write leaves the last complete profile intact instead of a half-file the reader reports as corrupt. Set `0600` **on the temp file, before the rename**, so the window where it exists with default permissions is closed; skip it on Windows rather than emulating it — no ACL manipulation.

  Deliberately **not** done: journals, `fsync` choreography, keychain integration, encryption at rest. Whole-file replacement of a small local JSON file is the proportionate mechanism (D6).
- [ ] **Step 3** — `npm test`, `npx tsc --noEmit`.

### Task 14: Settings UI

**Files:** `main.ts`

- [ ] Backend dropdown (`addDropdown`), then provider dropdown, model text field, base-URL text field, and an API-key field — all four shown only when `backend === "llm"`, with `display()` re-rendering on backend change.
**Bootstrap, recovery and the write moment — specify this before writing any UI code.** The tab edits a file that lives outside Obsidian's settings store, so the states Obsidian normally handles for you are now yours.

*On `display()`*, read the profile through core's reader and branch on its three outcomes:

| Reader result | UI state | Writes? |
| --- | --- | --- |
| `ok` | Controls populated from the profile. Key field **blank**, with adjacent text saying whether a key is stored. | No |
| missing file | Empty form. This is first run, not an error — say nothing alarming. | No |
| malformed | The reader's message shown inline, fields disabled except a **Start over** button that writes a fresh profile. | Only on explicit Start over |

**Never silently overwrite a malformed file.** It may still contain a key the user can recover by hand, and a settings tab that repairs itself by deleting the evidence is worse than one that says what is wrong.

*While editing*, hold an in-memory draft beside the loaded profile. Nothing is written on keystroke.

*The write moment* is one whole-profile rewrite per committed edit — on blur, matching the repo's existing commit-on-blur pattern — and **only when the draft is complete and valid**: provider set, model non-empty, `base_url` present for `openai-compatible`. An incomplete draft stays in memory and shows what is missing. It must not write a partial file, because Task 2's reader would then reject the file wholesale and the user would be one field short of a profile that no longer loads.

*The key* is carried in memory from the loaded profile, so a model or base-URL edit rewrites the file with the existing key without the user retyping it.

*`backend` is independent of the profile.* Switching to `llm` writes only `data.json` and never creates a credentials file. Until a valid profile exists the backend reports "not configured" through the normal failure path, and capture continues transcript-only — the same downgrade every other enhancement failure gets.

- [ ] The tab is an **editor over the credentials file**, not over `data.json`: `display()` loads the profile, edits rewrite the whole profile, and only `backend` round-trips through `saveSettings()`. Keep the in-memory profile so a model or base-URL edit can rewrite the file without the user retyping their key.
- [ ] The key field: `text.inputEl.type = "password"` set by hand (Obsidian's `Setting` has no native password mode, and nothing in this repo does this yet). **Render it blank rather than populated with the stored key** — a populated password field is one "reveal" or screen share from exposure, and it buys nothing. Semantics, stated in the description because they are not guessable: *blank means keep the existing key*, entering a value rotates it, and a separate **Clear key** button removes it. Without the explicit Clear, "blank preserves" would leave no way to remove a key at all. The `setDesc` also names where the key is stored and that it is deliberately outside the vault — consequence-specific copy, matching the house style of `controlShorthandRecording`'s description.
- [ ] Guard the existing Claude-executable row and its detection/error block (`main.ts:530-555`) behind `backend === "claude-agent-sdk"`, so an LLM-backend user is never told to install a CLI they do not need.
- [ ] Pass the right timeout for the context (D7, Task 8b): live capture gets `DEFAULT_CONFIG.enhancement.timeoutMs`, the standalone enhance path (`main.ts:450`) gets `standaloneTimeoutMs`. The plugin currently hands the same value to both.
- [ ] **`createEnhancer()` must become `async`.** It is synchronous today (`main.ts:530`) and called synchronously from `main.ts:242` and `main.ts:473`; `readLlmCredentials` is async. Convert the factory and both call sites, and check that `main.ts:246-250`'s try/catch still catches — an un-awaited rejection would bypass the "capture will continue with transcript only" downgrade and surface as an unhandled rejection instead.
- [ ] Branch `createEnhancer()`: on `llm`, read the credentials and construct `LlmAgentClient`; keep the conditional-spread style (`...(x === undefined ? {} : { key: x })`) that `exactOptionalPropertyTypes` forces. Consider passing a `fetch` that wraps Obsidian's `requestUrl` — decide from the Task 1 spike whether the plain global `fetch` suffices under Electron; if it does, do not add the wrapper, and record that it was unnecessary.
- [ ] **Add the missing `skipped` branch to `onEnhanceStatus` (`main.ts:627`).** This is where provider failures currently vanish: a bad key or an unreachable Ollama becomes `failureReason: "query-error"` (`contract.ts:207-213`), which the runner emits as kind `skipped` (`runner.ts:250-256`), which the plugin has no case for — so every pass fails silently, forever. Route `status.message` through `fail()`.

  Fix it **here, not in core's taxonomy.** Core already draws the distinction correctly: `not-ready` means nothing to do, `skipped` means a pass was attempted and did not land, and `PassOutcome` separates `invalid-output` from `agent-error` (`runner.ts:51`, `:130`, `:250`). The silence is one absent consumer branch, not a missing status kind, and inventing a new kind would be a breaking public change that buys nothing.

- [ ] Surface credential failures through the same `fail()` → `Notice` + status-bar path. A missing or invalid credentials file must be a clear notice naming the remedy, and must not abort capture — enhancement is optional, and `main.ts:246-250` already downgrades enhancement failures to "capture will continue with transcript only."

### Task 15: Plugin gate and docs

- [ ] The plugin's own gate before anything is released: `npm test`, `npx tsc --noEmit`, `npm run build` (`AGENTS.md:15`). Phase C is not done until all three are green — Phase A's four gates cover core only.

- [ ] `README.md`: a backend section near Prerequisites explaining that the `claude` CLI requirement applies to the default backend only; how to configure the LLM backend; **where the API key is stored and that it is deliberately not in the vault** (name the path); the blank-preserves / Clear-removes semantics of the key field, which are not guessable from the UI; and the vault-lookup capability gap (D3) stated plainly as a difference, not buried.

---

## Deferred, deliberately

- **The Codex SDK backend.** Same seam, and this plan's job is to prove the seam takes a second implementation. Adding a third at the same time would design the abstraction around two hypotheticals instead of one real case.
- **A vault-tool loop for the LLM backend** (D3). Its own change, with its own confinement tests.
- **`shorthand-config`.** It ships `shorthand-notes` as a sidecar and already writes `google-credentials.json` from Rust; teaching it to write `llm-credentials.json` is the natural follow-up and the conformance suite from Task 6 is what it would be held to. Out of scope here.
- **Streaming.** `EnhanceRunner` consumes one structured result per pass; streaming buys nothing until there is a UI to stream into.
- **Token/cost reporting.** The AI SDK returns normalised `usage`, so this is cheap to add later, but nothing consumes it today.

## Risks

| Risk | Mitigation |
| --- | --- |
| `undici` in `@ai-sdk/provider-utils` breaks the plugin bundle | Task 1 Step 1 spikes it before any code is written. A failure sends D1 back to the direct-SDK runner-up rather than into a workaround. |
| AI SDK major-version churn (v5→v6→v7 within a year) | Every `ai` import is confined to `src/agent/llm-client.ts` (fact 3), so a migration touches one file. Vercel ships codemods. |
| An endpoint silently ignores `responseFormat` (D1) | `validateSectionOutput` plus the corrective retry, which Task 4 keeps reachable by converting `NoObjectGeneratedError` into `structuredOutput: undefined`. Watch for passes failing twice; that pattern means the endpoint or model is not honouring the schema, not that the SDK is wrong. |
| Ollama structured output is model-dependent | Not fixable from here. Document it: local-model quality is the user's variable, and a weak model will fail validation more often. |
| Users expect vault lookups and quietly lose them | Task 9 and Task 15 both document it. The default backend is unchanged, so this only reaches users who opted out. |
