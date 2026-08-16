# Obsidian Handy Notes

Handy Notes captures Handy's live microphone and system-audio transcript into a linked sidecar note. Stateless Claude Agent SDK passes use the new transcript plus your notes to maintain a structured summary in the meeting note. Sections may be added, rewritten, reordered, or removed as the meeting develops.

The headless core owns capture, transcript reconciliation, enhancement, and all writes. The Obsidian plugin is a thin desktop lifecycle and UI wrapper around that same core.

Granola-style meeting notes for Obsidian, driven by [Handy](https://github.com/cjpais/Handy)'s
`--follow-stream` CLI: Handy transcribes your microphone and system audio as separate
speaker-labelled lanes, and this keeps an AI-owned summary in the note while the meeting is
still running.

**Background:** [`docs/DESIGN.md`](docs/DESIGN.md) records the requirements, the deliberate
decisions, the invariants that must not be weakened, and the bugs found by running it rather
than reading it. [`docs/original-plan.md`](docs/original-plan.md) is the plan as approved
before implementation.

## Prerequisites

- Handy must be running with **Follow Live Transcript Output** enabled under **Advanced settings**. If Handy is stopped or that setting is disabled, `--follow-stream` exits with code 2 and Handy Notes reports both remedies.
- The `claude` CLI must be installed and logged in. On Windows the standard `C:\Users\<you>\.local\bin\claude.exe` location is detected; another location can be configured in the plugin or passed with `--claude`.
- Node.js 20 or Bun is required for headless CLI use. Bun is required for the development build and test commands.

## Install the Obsidian plugin

### From a release (no toolchain required)

Download `main.js` and `manifest.json` from the [latest release](../../releases/latest) into:

```text
<vault>/.obsidian/plugins/handy-notes/
```

Releases are produced by `.github/workflows/release.yml` — push a tag matching the
`plugin/manifest.json` version and CI typechecks, tests, builds, attests provenance, and
opens a draft release with both assets:

```sh
git tag 0.1.0 && git push origin 0.1.0
```

The tag must match the manifest version or the workflow fails deliberately, because Obsidian
installs by manifest version and a mismatch would ship a plugin that reports the wrong one.

### From source

From this package, build the plugin:

```sh
bun run build:plugin
```

Copy the contents of `plugin/`—at minimum `manifest.json` and the generated `main.js`—into:

```text
<vault>/.obsidian/plugins/handy-notes/
```

Reload Obsidian, enable **Handy Notes** under Community plugins, and configure the executable paths and budgets in its settings tab.

The plugin provides these commands:

- **Handy: start capture on this note**
- **Handy: stop capture**
- **Handy: enhance now**

Capture starts only on the active Markdown note. If it has no ownership markers, the plugin offers to append the same seeded marker scaffold used by `init-note`. Malformed, duplicate, nested, or inverted markers are never repaired automatically.

## Headless CLI

Build the standalone CLI first:

```sh
bun run build
```

Initialize a new meeting note and its transcript link:

```sh
node dist/handy-notes.mjs init-note --vault "C:\path\to\vault" --note "Meetings/Standup.md"
```

Capture into the linked sidecar, with live enhancement enabled:

```sh
node dist/handy-notes.mjs capture --vault "C:\path\to\vault" --note "Meetings/Standup.md" --enhance --handy "C:\path\to\handy.exe" --claude "C:\path\to\claude.exe"
```

Run an on-demand link-tier pass against an existing transcript:

```sh
node dist/handy-notes.mjs enhance --vault "C:\path\to\vault" --note "Meetings/Standup.md" --transcript "Meetings/Transcripts/standup.md" --tier link
```

For all available flags:

```sh
node dist/handy-notes.mjs
```

## Ownership-marker contract

Handy Notes owns only the bytes strictly between one well-ordered marker pair:

```markdown
<!-- handy:notes -->
- Your rough notes remain user-owned.

<!-- handy:ai:start -->
## Summary
AI-maintained sections live here.
<!-- handy:ai:end -->
```

Every AI update re-reads the file, verifies the current block hash, splices only the marker body, writes a same-directory temporary file, and atomically renames it over the note with lock retries. Marker anomalies fail closed. The agent has no write tools; all note writes go through the core file writer, never through Obsidian's vault API.

## Known limitations

- Because the core writes directly to disk, Obsidian notices updates through its file watcher. If the note has unsaved keystrokes in Obsidian's editor buffer, that buffer can win on its next save and an AI update may be lost. This is the intentionally safe direction: Handy Notes does not discard user text.
- Under Claude subscription authentication, `total_cost_usd` is commonly `0`. In that case the configured USD budget is inert, so the pass-count budget is the real hard cap.
- A stream disconnect cannot replay missed Handy events. Reconnects add a visible transcript-gap warning to the sidecar.
- The plugin requires a desktop, filesystem-backed vault.

## Offline verification

The unit suite and smoke test use local fixtures only; they do not require Handy, Claude, Obsidian, or network access:

```sh
bun run build
bun run build:plugin
bun run typecheck
bun test
node test/e2e-smoke.mjs
```

The smoke script creates and removes a scratch vault, initializes a note, captures from `--fake-stream`, enhances with `--agent-stub`, and verifies that only the AI marker body changed.
