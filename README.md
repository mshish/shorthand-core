# shorthand-core

The headless engine behind Shorthand: it captures [Shorthand](https://github.com/cjpais/Shorthand)'s
live microphone and system-audio transcript into a linked sidecar note, and runs enhancement
passes through either the default Claude Agent SDK backend or ordinary LLM provider APIs. Those
passes use the new transcript plus your own notes to maintain a structured summary in the meeting
note. Sections may be added, rewritten, reordered, or removed as the meeting develops.

Core owns capture, transcript reconciliation, enhancement, and every write. It has **no Obsidian
dependency**: writes go straight to files and Obsidian picks up external changes itself. Two
payoffs — the whole pipeline is testable end to end without launching Obsidian, and nothing (no
MCP server, no plugin install) stands between the agent and the note.

**Consumers.** The Obsidian plugin lives in its own repository,
[`mshish/obsidian-shorthand-notes`](https://github.com/mshish/obsidian-shorthand-notes), and depends on
this package by name and a pinned tag. A `bin/shorthand-notes` CLI in this repo drives the same
pipeline headlessly.

**Background:** [`docs/DESIGN.md`](docs/DESIGN.md) records the requirements, the deliberate
decisions, the invariants that must not be weakened, and the bugs found by running it rather
than reading it. [`docs/ENHANCEMENT-LIMITS.md`](docs/ENHANCEMENT-LIMITS.md) tabulates the gates,
timeouts and retry limits that decide when an enhancement pass runs.
[`docs/CONTRACT.md`](docs/CONTRACT.md) is the contract between core and a
consumer — read it before writing a second output target.
[`docs/original-plan.md`](docs/original-plan.md) is the plan as approved before implementation.

## Package layout

Core is consumed **by package name only**, through the `exports` map in `package.json`. There are
no deep imports and no tsconfig `paths` — `exports` is the enforcement, honoured by `tsc`,
esbuild and Node alike, so a deep path fails to resolve rather than merely being discouraged.

| Specifier | Entry point | Contains |
| --- | --- | --- |
| `shorthand-core` | `src/index.ts` | The engine plus the `NoteSink` and `SidecarStore` ports |
| `shorthand-core/markdown` | `src/markdown.ts` | `MarkdownNoteSink`, the transport-free Markdown document codec, and note scaffolding |
| `shorthand-core/google` | `src/google.ts` | The Google Docs sink, credentials reader, and capture resolver |
| `shorthand-core/testing` | `src/testing/index.ts` | Runner-independent executable contracts for sinks and credentials writers |

Entry points use explicit named re-exports, never `export *`. The Markdown codec exposes complete
document results and exact UTF-16 text edits, while hashes, parsers, marker tokens, filesystem
writers, and test seams remain private; [`docs/CONTRACT.md`](docs/CONTRACT.md) lists them and says
why. `bin/` is internal to core rather than a consumer, so its direct use of the block writer is
legitimate.

## Consuming core

Because the package is not on npm, you install it from GitHub and pin it to a tag:

```json
"shorthand-core": "github:mshish/shorthand-core#<tag>"
```

Use **npm**, not bun: npm resolves that URL by cloning through the `gh` credential helper, while
bun rewrites GitHub dependencies to the API tarball endpoint and 404s on a private repository
regardless of the token supplied. Core itself develops with bun.

Core's tags exist **only** as dependency pins. There is no release workflow here and no
`main.js`; the Obsidian plugin's releases are cut from the plugin repository.

## Prerequisites

- Shorthand must be running with **Follow Live Transcript Output** enabled under **Advanced
  settings**. If Shorthand is stopped or that setting is disabled, `--follow-stream` exits with code 2
  and core reports both remedies.
- For the default Claude backend, the `claude` CLI must be installed and logged in. On Windows
  the standard `C:\Users\<you>\.local\bin\claude.exe` location is detected; another location
  can be passed with `--claude`.
- For the `codex` backend, an installed `codex` CLI is **found on `PATH` automatically** — no
  configuration. Core does that search itself because nothing downstream does one:
  `@openai/codex-sdk`'s `findCodexPath()` resolves its vendored binary out of `node_modules` and
  throws if it is not there, and never consults `PATH` at all. The consequence is that the
  version actually running is whatever the first `codex` on your `PATH` is, not the SDK version
  pinned in `package.json`. On Windows only a real `codex.exe` is accepted: the npm-generated
  `codex`, `codex.cmd` and `codex.ps1` shims cannot be spawned without a shell, so they are
  skipped in favour of a later `PATH` entry holding the real binary.
  `--codex-exe <path>` / `SHORTHAND_CODEX_EXE` overrides the search and takes either a full path
  or a bare command name to look up on `PATH`. You do still need to be logged in
  (`codex login`), because the backend reuses that login rather than asking for a key — see the
  credential note below.
  The isolated `CODEX_HOME` this backend runs under discards your `config.toml`, including your
  selected model and any custom endpoint; re-supply those with `--codex-model <model>` /
  `SHORTHAND_CODEX_MODEL` and `--codex-base-url <url>` / `SHORTHAND_CODEX_BASE_URL`.
- Node.js 22 for headless CLI use. The floor follows a dependency's requirement rather than a
  preference: the AI SDK packages (`ai`, `@ai-sdk/*`) declare `engines.node >=22`. Bun is
  required for the development build and test commands.

## Enhancement backends

The CLI selects a backend with `--backend claude|llm|codex`; omitting the flag selects
`claude`. The default backend resumes a Claude Agent SDK session and requires the `claude` CLI
described above. The `llm` backend instead uses the Vercel AI SDK to call OpenAI, Anthropic,
Ollama, or another OpenAI-compatible endpoint, and does not launch Claude Code. The `codex`
backend wraps OpenAI's `@openai/codex-sdk` and, by default, reuses a locally logged-in `codex`
CLI session — no credentials file, no required API key (an `apiKey` constructor override
exists for the rarer case). It runs every pass in a scratch working directory this client
owns, with `sandboxMode: "read-only"`, `approvalPolicy: "never"`, and no tools ever forwarded
to the model in the allowlist sense — see "Invariants" in `docs/DESIGN.md` for the capability
gap this accepts. It also runs the child against an isolated `CODEX_HOME`, which is what keeps
your MCP servers out of a transcript-facing process. The visible cost is that your own
`config.toml` does not apply: the model is the installed CLI's default, and the endpoint is
whatever `codex` itself defaults to, unless the caller sets `CodexAgentClientOptions.model` /
`baseUrl` — the CLI does this for you via `--codex-model`/`SHORTHAND_CODEX_MODEL` and
`--codex-base-url`/`SHORTHAND_CODEX_BASE_URL`, described above.

The LLM profile is `llm-credentials.json` under Shorthand's configuration directory: on
Windows, `%APPDATA%\Shorthand\llm-credentials.json`; on macOS,
`~/Library/Application Support/Shorthand/llm-credentials.json`; and on Linux,
`${XDG_CONFIG_HOME:-~/.config}/shorthand/llm-credentials.json`. It contains the provider,
model, optional API key and `base_url` (required for `openai-compatible`, optional otherwise).
This location is deliberately outside the vault so a plaintext provider key is not copied
through vault sync or included in vault backups.

The backends do not have identical lookup capabilities. Claude link-tier passes can use
`Read`/`Glob`/`Grep` inside the vault. The LLM and Codex backends have no vault-confined tool
loop (`supportsVaultTools` is `false` for both), so every pass runs as a tick pass, including
the closing pass: its notes will not reference people, projects or prior meetings discovered
elsewhere in the vault.

## Headless CLI

Build the standalone CLI first:

```sh
bun install
bun run build
```

Initialize a new meeting note and its transcript link:

```sh
node dist/shorthand-notes.mjs init-note --vault "C:\path\to\vault" --note "Meetings/Standup.md"
```

Capture into the linked sidecar, with live enhancement enabled:

```sh
node dist/shorthand-notes.mjs capture --vault "C:\path\to\vault" --note "Meetings/Standup.md" --enhance --shorthand "C:\path\to\shorthand.exe" --claude "C:\path\to\claude.exe"
```

Run an on-demand link-tier pass against an existing transcript:

```sh
node dist/shorthand-notes.mjs enhance --vault "C:\path\to\vault" --note "Meetings/Standup.md" --transcript "Meetings/Transcripts/standup.md" --tier link
```

For all available flags:

```sh
node dist/shorthand-notes.mjs
```

`dist/` and `test/` must stay siblings at runtime: `bin/shorthand-notes.ts` resolves
`../test/fixtures/fake-stream.mjs` relative to the bundle, so `--fake-stream` needs the fixture
directory alongside the build.

## Ownership-marker contract

Core owns only the bytes strictly between one well-ordered marker pair:

```markdown
<!-- shorthand:notes -->
- Your rough notes remain user-owned.

<!-- shorthand:ai:start -->
## Summary
AI-maintained sections live here.
<!-- shorthand:ai:end -->
```

Every AI update re-reads the file, verifies the current block hash, splices only the marker body,
writes a same-directory temporary file, and atomically renames it over the note with lock retries.
Marker anomalies fail closed. The agent has no write tools; all note writes go through the core
file writer.

## Known limitations

- Because core writes directly to disk, Obsidian notices updates through its file watcher. If the
  note has unsaved keystrokes in Obsidian's editor buffer, that buffer can win on its next save
  and an AI update may be lost. This is the intentionally safe direction: user text is never
  discarded.
- Enhancement has no pass or USD budget — both were removed. Under Claude subscription
  authentication `total_cost_usd` is commonly `0`, so a USD cap never trips, and a raw pass
  count can't tell a long meeting from a runaway loop. Instead, enhancement runs inside a
  wall-clock window (`maxDurationMs`, 4h by default) as a loop-breaker backstop; the interval
  gate (`minIntervalMs`) is what actually bounds pass rate. Set `HANDY_NOTES_MAX_DURATION_MS`
  to override the window (this replaces the older `HANDY_NOTES_MAX_PASSES`,
  `HANDY_NOTES_MAX_USD`, and `HANDY_NOTES_MAX_PASS_USD` variables, which no longer exist).
- A stream disconnect cannot replay missed Shorthand events. Reconnects add a visible transcript-gap
  warning to the sidecar.

## Offline verification

The unit suite and smoke test use local fixtures only; they do not require Shorthand, Claude,
Obsidian, or network access:

```sh
bun run typecheck
bun test
bun run build
bun run test:e2e
```

The smoke script creates and removes a scratch vault, initializes a note, captures from
`--fake-stream`, enhances with `--agent-stub`, and verifies that only the AI marker body changed.
CI (`.github/workflows/ci.yml`) runs exactly this.

Writing a second sink? `shorthand-core/testing` exports the conformance suite as plain async
functions plus a thin adapter over any runner's `describe`/`test`, so it runs from another
package and another test runner unchanged. Every sink must pass it.

## Cutting a core tag

Consumers pin by tag, so a tag is a compatibility promise:

```sh
git tag -a 0.10.0 -m "0.10.0 — <summary>"
git push origin 0.10.0
```

**Annotated**, and bare with no `v` prefix. Every tag in this repo is a tag object and
`AGENTS.md` requires that. The consequence worth knowing: `git ls-remote --tags origin 0.10.0`
returns the tag object, not the commit, so use `git rev-parse 0.10.0^{}` when you need to know
where a tag actually points.

Then bump the dependency line in each consumer and run its own verification. There is no release
workflow and no artifact — the tag is the whole deliverable.
