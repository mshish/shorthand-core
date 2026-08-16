# Obsidian Handy Notes

Handy Notes captures Handy's live microphone and system-audio transcript into a linked sidecar note. Stateless Claude Agent SDK passes use the new transcript plus your notes to maintain a structured summary in the meeting note. Sections may be added, rewritten, reordered, or removed as the meeting develops.

The headless core owns capture, transcript reconciliation, enhancement, and all writes. The Obsidian plugin is a thin desktop lifecycle and UI wrapper around that same core.

Granola-style meeting notes for Obsidian, driven by [Handy](https://github.com/cjpais/Handy)'s
`--follow-stream` CLI: Handy transcribes your microphone and system audio as separate
speaker-labelled lanes, and this keeps an AI-owned summary in the note while the meeting is
still running.

**Background:** [`docs/DESIGN.md`](docs/DESIGN.md) records the requirements, the deliberate
decisions, the invariants that must not be weakened, and the bugs found by running it rather
than reading it. [`docs/CONTRACT.md`](docs/CONTRACT.md) is the contract between core and a
consumer — read it before writing a second output target.
[`docs/original-plan.md`](docs/original-plan.md) is the plan as approved before implementation.

## Package layout

Core is consumed **by package name only**, through the `exports` map in `package.json`. There
are no deep imports and no tsconfig `paths` — `exports` is the enforcement, honoured by `tsc`,
esbuild and Node alike, so a deep path fails to resolve rather than merely being discouraged.

| Specifier | Entry point | Contains |
| --- | --- | --- |
| `obsidian-handy-notes` | `src/index.ts` | The engine and the `NoteSink` port |
| `obsidian-handy-notes/markdown` | `src/markdown.ts` | `MarkdownNoteSink` — the reference sink — and note scaffolding |
| `obsidian-handy-notes/testing` | `src/testing/sink-conformance.ts` | The executable `NoteSink` conformance suite, runner-independent |
| `obsidian-handy-notes/plugin-ui` | `src/plugin/index.ts` | Obsidian plugin settings and status reducer |

Entry points use explicit named re-exports, never `export *`. Block-format internals and test
seams are deliberately not exported; [`docs/CONTRACT.md`](docs/CONTRACT.md) lists them and
says why. `bin/` is internal to core rather than a consumer, so its direct use of the block
writer is legitimate.

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

Releases are produced by `.github/workflows/release.yml` — push a tag equal to the
`plugin/manifest.json` version and CI typechecks, tests, builds, attests provenance, and opens
a draft release with both assets:

```sh
git tag 0.1.0 && git push origin 0.1.0
```

The tag must **equal** the manifest version exactly, with no prefix, or the workflow fails
deliberately. Both [BRAT](https://github.com/TfTHacker/obsidian42-brat) and Obsidian's community
listing require that, and BRAT treats the tag as the source of truth — on a mismatch it
overrides the manifest, shipping a plugin that reports the wrong version.

**`plugin/manifest.json` is the single source of truth for the plugin version.** The root
`package.json` is `private` and pinned to `0.0.0` precisely so it cannot disagree: it is never
published and never read for a version, so there is no second number to keep in sync.

The workflow is scoped by tag **shape** rather than a prefix, so a sibling tool in this repo
still cannot cut an Obsidian release — `apisink-v0.1.0` does not match a bare-version glob. An
earlier `obsidian-v*` scheme gave the same isolation but silently broke BRAT and community
listing, which is why shape-scoping is used instead.

### Install from the repo with BRAT

BRAT installs from a **release**, not from the repo tree, so cut one first. This repository is
private, so BRAT needs a fine-grained personal access token with read-only **Contents**
permission on it, added in BRAT's settings; then add `mshish/obsidian-handy-notes` as a beta
plugin.

BRAT is the right path for testing a real build or installing on another machine. For a tight
edit-build-reload loop, `bun run dev:plugin` below is faster — it skips the release cycle
entirely.

### From source, while developing

Build and install into a vault in one step:

```sh
bun run dev:plugin --vault "C:\path\to\vault"
```

Or set `HANDY_NOTES_VAULT` once and drop the flag. `install:local` alone installs without
rebuilding. Both copy **only** `main.js` and `manifest.json`; `data.json` is your saved settings
and is never touched.

Obsidian caches the bundle, so **toggle the plugin off and on** (or reload Obsidian) after
installing — otherwise you are still running the previous build, which looks exactly like your
change having no effect.

This copies rather than symlinking on purpose. A junction inside a OneDrive-synced vault makes
OneDrive follow it and re-upload a 6.7 MB bundle on every rebuild.

### From source, manually

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

`bun run typecheck` covers `bin/`, `plugin/`, `src/` and `test/`. `plugin/main.ts` is included
and `obsidian` is a pinned devDependency (1.5.7, matching `manifest.json`'s `minAppVersion`)
purely so that typings exist — the plugin bundle still marks `obsidian` external, so nothing
of it is shipped.
