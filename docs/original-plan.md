# Obsidian AI note taker on Handy's `--follow-stream`

## Context

This fork of Handy transcribes microphone **and** Windows system audio as two speaker-labelled lanes
and exposes the live transcript over `handy --follow-stream` (NDJSON on stdout, backed by a per-user
local socket — `FOLLOW_STREAM.md`). That CLI has no consumer yet, so the feature is unproven.

The first consumer is an Obsidian plugin modelled on Granola: you type rough notes during a call and
an AI keeps a structured summary in the same note. **The notes evolve as the meeting evolves** —
sections are added, rewritten, reordered and dropped mid-meeting, so the note-taker never has to go
back and fix structure afterwards. The AI work runs through the **Claude Agent SDK**, which buys
what a plain summarizer cannot: on demand, the agent reads the rest of the vault (prior meetings,
people, projects) and wires the new note into it.

Deliverable at `D:/tools/Handy/obsidian-shorthand-notes/`, kept **out of git**, to be moved to its own
repo later.

**This plan has been through one Codex review** (`gpt-5.6-sol`); its blockers are folded in below and
called out where they changed the design.

## Constraints taken as given

- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), not the raw Messages API.
- Transcript in a **sidecar note**, linked from the meeting note.
- Auth reuses the already-logged-in `claude` CLI (`C:\Users\<user>\.local\bin\claude.exe`).
- The agent **never writes files**. All writes are plugin code.
- Live enhancement during the meeting, restructuring as it goes.
- **Streaming-capable models only** — this fork uses nothing else, so there is no non-streaming
  degradation path to build or test.
- **Codex (`gpt-5.6-sol`) implements; a Claude subagent reviews each increment.**

## Architecture

**Headless core, thin plugin.** Everything of consequence lives in a plain Node package with no
Obsidian dependency, driven by a CLI. Writes go **directly to files on disk**; Obsidian picks up
external changes on its own. The Obsidian plugin is a last-phase wrapper that starts/stops the same
core and shows status — no Obsidian API in any load-bearing path.

Two payoffs: the whole pipeline is testable end to end without a human clicking in Obsidian, and
there is no Obsidian-side write API, MCP server, or plugin install standing between the agent and
the note.

```
handy.exe --follow-stream json     (child process, stdout NDJSON)
        |
        v
  StreamClient ──► TranscriptStore ──► sidecar note   (fs write, append)
  (framing, resync,   (per connection-
   lifecycle)          generation+session+speaker)
        |
        | trigger policy
        v
  EnhanceRunner ──► Agent SDK query()  ──► fenced-JSON section array
  (stateless passes,   (NO resume)              |  (zod-validated, 1 retry)
   two tiers)                                   v
                                        BlockWriter ──► meeting note on disk, only
                                                        inside the handy:ai markers
```

### Ownership invariant

The meeting note is split by HTML-comment markers. The plugin only ever replaces text strictly
between `<!-- handy:ai:start -->` and `<!-- handy:ai:end -->`.

```markdown
---
handy-capture: 2026-08-15T14:03:20-07:00
handy-transcript: "[[Meetings/Transcripts/2026-08-15 1403]]"
---
# 2026-08-15 Standup

<!-- handy:notes -->
- rough bullets the user types live        <- user-owned, never written by us

<!-- handy:ai:start -->
## Summary
## Decisions
<!-- handy:ai:end -->
```

The agent has no write tool. `options.tools` never contains `Write`/`Edit`/`Bash`, which removes them
from the agent's context entirely (SDK availability layer). **All file writes are core code.**

*No MCP layer.* The earlier design routed the agent's output through an in-process MCP tool. Dropped
in favour of a plain output contract: the agent's final message must be a single fenced ` ```json `
block holding the section array, which the core extracts, zod-validates, and writes. One retry with
the validation error on malformed output; on a second failure the pass is skipped and the last good
sections stand. That is one less concept than an MCP server for the same guarantee, and it behaves
identically headless and in-plugin.

**Sections evolve.** The contract is the **complete ordered array** of sections
(`[{heading, markdown}]`), not a patch. The block is regenerated wholesale from the validated array,
so adding, renaming, reordering and dropping sections all fall out of one code path with no merge
logic. The template only seeds the first pass.

### Concurrency: how the invariant actually holds (Codex blockers 1 and 2)

An enhancement pass is async; the user keeps typing. Three rules make the splice safe:

1. **Read-splice-write, never regenerate.** Every write re-reads the file from disk, locates the
   markers in *that* content, replaces only the block body, and writes the whole file back. Offsets
   are never carried across an `await`. The user's bytes outside the markers are whatever was on disk.
2. **Optimistic concurrency on the block.** At pass start the runner hashes the current block text;
   at write time it re-reads and re-hashes. If it differs — the user typed in the block, Sync landed
   a change — the agent result is **discarded and the pass re-queued**. Never a blind overwrite.
3. **Atomic replace.** Write to a temp file in the same directory and `rename` over the target, so a
   crash mid-write cannot truncate the user's note.

**Fail-closed on marker anomalies.** The note must contain exactly one well-ordered `start`/`end`
pair. Zero, duplicated, nested or inverted markers → no write at all, log and continue capturing.
Agent-supplied content containing a marker token is rejected before the write.

**Known, accepted limitations** (both verified on this machine, not theoretical):

- If the note is open in Obsidian with unsaved keystrokes, Obsidian's editor buffer wins on its next
  save and an AI block update can be lost. The failure direction is the safe one — we lose an AI
  update, never the user's text — and the hash check re-queues the pass.
- **File locking is the dominant real-world failure.** On Windows, `rename` over a note held open by
  another process fails `EPERM` — reproduced by holding a plain `r+` handle. Obsidian, on-access AV,
  and **OneDrive (this vault lives under it)** all hold notes open. The writer therefore retries the
  rename with backoff and reports a distinct `note-locked` status so a pass is re-queued rather than
  failed. A residual window remains between the verify-read and the rename where an external save
  would be overwritten; our own processes serialize with a lock file, but a foreign writer inside
  that window cannot be excluded with plain filesystem primitives.

### Enhancement passes: stateless and bounded (Codex blocker 3)

The original design resumed one SDK session for the whole meeting. That grows retained context at
least linearly in passes while re-sending section snapshots and accumulating vault tool results, and
prompt caching lowers unit price, not context size. **Dropped.**

Instead: **every pass is a fresh, stateless `query()` with no `resume`.** The note is the state. A
pass input is bounded regardless of meeting length:

- the current section array (the accumulated summary),
- the transcript committed since the last pass,
- the user-notes region.

Two tiers, because vault search on every tick is disproportionate:

| Tier | When | `tools` | Cost shape |
|---|---|---|---|
| **Tick** | live: ≥600 new chars **and** ≥60 s since last pass ended **and** none in flight | `[]` — no vault access | small, frequent |
| **Link** | on stop, and the `Handy: enhance now` command | `["Read","Glob","Grep"]` | occasional |

**Hard budget per meeting** (pass count and USD, from the result message's cost field, both
configurable): on exhaustion the runner stops enhancing, keeps capturing, and says so in the status
bar. Cost is displayed only because there is now a ceiling to display against.

**Watermark rule, stated explicitly:** the transcript offset advances at **pass start**, and text
arriving mid-pass belongs to the next pass. No drop, no double-processing.

Fixed SDK options: `cwd` = vault root; our own `systemPrompt` (not the `claude_code` preset);
`settingSources: []` so the user's `~/.claude` config and any vault `CLAUDE.md` cannot alter
behavior; `pathToClaudeCodeExecutable` auto-detected and overridable; `maxTurns` capped per pass;
per-pass wall-clock timeout that abandons the result rather than blocking the next tick.

**Untrusted input.** Transcript text and vault files are untrusted and can carry injection attempts.
Structural mitigation: no write tools exist, `set_sections` output is schema-validated, marker tokens
are rejected, and the block hash check means a hijacked pass can at worst produce bad summary text
inside a region the user can undo — never a write elsewhere in the vault.

### Stream handling (Codex blocker 4 and the majors)

`--follow-stream json` rather than `delta`: json carries the full lifecycle (`begin`, `final`,
`no_speech`, `cancel`, `error`) and, critically, connection-level `error` records with a `code` such
as `follower_limit`, which the exit code cannot distinguish. Computing the append-only suffix from
`partial.committed` is ~15 lines.

Rules the parser must implement, each with a test:

- **Framing** — decode with a streaming UTF-8 decoder (`StringDecoder`), not manual buffer slicing:
  multibyte characters split across chunks, several lines per chunk, unterminated tail at exit.
- **Keying** — `(connectionGeneration, session, speaker)`. Handy's session numbers are process-local
  and reused after a Handy restart; the generation counter, bumped on every reconnect, keeps keys
  unique.
- **Resync** — if a `partial.committed` does not extend the stored prefix (legal: snapshots coalesce),
  replace the stored prefix and rewrite that speaker's tail in the sidecar rather than appending.
- **`final` reconciliation** — `final` is the authoritative, punctuated text and its shape differs by
  lane (single-lane carries `speaker`; dual-lane omits it and is pre-merged). On `final`, the
  session's sidecar block is **replaced** by the final text, not appended to.
- **Ordering** — `session_elapsed_ms`, never `emitted_at`. It timestamps when text was *committed*,
  not spoken, and the two lanes run independent VAD; the sidecar labels it as commit time and does
  not claim exact conversational chronology.
- **Termination** — EOF or clean disconnect mid-session is `incomplete`, distinct from a terminal
  `final`/`cancel`; `client.rs` returns exit 0 for a clean disconnect, so exit 0 alone is not proof
  of a completed session.
- **Reconnect** — the protocol has no persistence or replay. On unexpected exit during capture:
  bounded retries with backoff, a visible `> [!warning] transcript gap` marker in the sidecar, and a
  new connection generation. Give up after N attempts and surface it.
- **Forward compat** — ignore unknown fields and unknown `t` values; check `hello.protocol`.

Exit codes are used only for start-up diagnosis: `2` = Handy not running **or** "Follow Live
Transcript Output" disabled in Advanced settings; `1` = other, with stderr surfaced verbatim.

### Other failure modes covered

Stop/drain ordering (stdout drained to the terminal event before the final link pass and before
killing the child); Obsidian or plugin crash mid-capture (capture state persisted, sidecar recovered
on reload); note or sidecar renamed/deleted/read-only/disk-full; sidecar write coalescing so a busy
stream does not thrash the vault; agent timeout, expired auth, rate limit, malformed or late tool
call.

## Implementation phases

Codex (`gpt-5.6-sol`) implements each phase; a Claude subagent reviews each increment before the next
begins, and I fold review findings back to Codex.

Because the core is headless, every phase below is verified by me running it — no human-in-Obsidian
step until the very end. `handy.exe` exists at `src-tauri/target/release/` and
`follow_stream_enabled` is already `true` in the settings store, so the real stream is drivable.

**Phase 1 — capture core, zero AI.** `StreamClient` (spawn, framing, lifecycle, reconnect, exit-code
mapping), `TranscriptStore` (keying, resync, `final` reconciliation, deltas), sidecar writer, and a
`shorthand-notes capture` CLI. Full unit suite plus a **fake-stream fixture script** that replays the
documented NDJSON so the pipeline is testable without Handy running at all.

**Phase 2 — block writer.** Marker parsing, block regeneration from a section array, read-splice-
write with atomic rename, hash concurrency check, fail-closed marker rules. Pure functions, heavily
unit-tested; verified against a scratch vault directory.

**Phase 3 — the agent.** `EnhanceRunner`: stateless passes, the two tiers, trigger policy, watermark,
budgets, timeouts, the fenced-JSON output contract with zod validation and one retry. Verified by
running the real Agent SDK against a scratch note.

**Phase 4 — end-to-end + Obsidian plugin.** Full run against real `handy.exe` in a scratch vault.
Then the thin plugin: start/stop commands, status bar, settings — wrapping the same core. Install is
a folder copy; the README covers it.

## Critical files

New, under `D:/tools/Handy/obsidian-shorthand-notes/`:

| Path | Role |
|---|---|
| `package.json`, `tsconfig.json` | headless core, no Obsidian dependency |
| `bin/shorthand-notes.mjs` | CLI entry: `capture --note <path> [--vault <path>]` |
| `src/stream/client.ts` | spawn, framing, reconnect, exit-code mapping |
| `src/stream/transcript.ts` | keying, resync, `final` reconciliation, deltas |
| `src/note/markers.ts` | pure marker/block string functions (heavily unit-tested) |
| `src/note/writer.ts` | read-splice-write, atomic rename, hash concurrency check |
| `src/agent/runner.ts` | stateless passes, tiers, trigger policy, budgets |
| `src/agent/contract.ts` | fenced-JSON extraction + zod schema + retry |
| `src/config.ts` | template, thresholds, budgets, binary paths |
| `test/fixtures/fake-stream.mjs` | replays documented NDJSON; makes the pipeline testable offline |
| `plugin/` | Phase 4 only: thin Obsidian wrapper (`manifest.json`, `main.ts`, esbuild) |

Handy files are **read-only references**, not modified: `FOLLOW_STREAM.md`,
`src-tauri/src/follow_stream/{client,protocol}.rs`.

## Repo hygiene

Add `obsidian-shorthand-notes/` to `.git/info/exclude` — local-only, unlike `.gitignore` which is tracked
and would itself be a commit. No commits in this repo for this work.

## Verification

- **Unit** (bun test): marker functions (idempotence, never writes outside markers, fail-closed on
  zero/duplicate/nested/inverted markers, marker tokens in agent content rejected); framing
  (multibyte split across chunks, multi-line chunks, unterminated tail); keying across a simulated
  Handy restart; resync on a non-extending snapshot; `final` replacing committed text in both lane
  shapes; watermark advance-at-start; hash-mismatch → discard and re-queue; budget exhaustion.
- **Contract**: the exact JSONL samples in `FOLLOW_STREAM.md` (single- and dual-speaker) through the
  parser, asserting the resulting transcript.
- **Manual end-to-end** — the acceptance test: Handy running with follow-stream enabled → `Handy:
  start capture` on a new note → play a video (system lane) while speaking (mic lane) → type bullets
  in the notes region *while a pass is in flight* → confirm the AI block fills, **restructures**
  mid-meeting, and that nothing outside the block is ever modified and in-block typing is never
  clobbered → stop → final link pass adds vault links → child process exits, no orphan.
- **Failure paths, deliberately exercised**: Handy not running and setting disabled (both exit 2,
  distinct actionable message); `claude.exe` missing (capture still works, AI disabled); Handy killed
  mid-capture (gap marker, reconnect); 9th follower (`follower_limit` surfaced from the stream, not
  the exit code); budget exhausted mid-meeting.
