# Design and requirements

Why this exists, what was asked for, which decisions were made deliberately, and what was
learned by running the thing rather than reasoning about it. Read this before changing the
invariants in `src/note/` or `src/agent/` — several of them look like over-caution and are
not.

## Requirements as given

The brief, in the order it arrived:

- A fork of [Shorthand](https://github.com/cjpais/Shorthand) captures and transcribes **system audio
  alongside the microphone**, as two speaker-labelled lanes, and exposes the live transcript
  over a CLI flag (`shorthand --follow-stream`) for piping.
- Build **the first consumer of that stream**: an Obsidian AI note taker. Proving the CLI is
  useful is half the point.
- It **must use the Claude Agent SDK** to invoke a Claude Code session — not the raw Messages
  API.
- Model the behaviour on **Granola**. Existing Obsidian plugins (Claudian) as integration
  inspiration.
- Distributed separately from Shorthand. Developed inside the Shorthand tree but never committed to
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
changes itself. The plugin supplies lifecycle and UI only — and now lives in its own
repository, [`mshish/obsidian-shorthand-notes`](https://github.com/mshish/obsidian-shorthand-notes),
which depends on this one by package name and a pinned tag.

Two payoffs: the whole pipeline is testable end to end without launching Obsidian, and
nothing — no MCP server, no plugin install — stands between the agent and the note.

```
shorthand.exe --follow-stream json     (child process, stdout NDJSON)
        |
        v
  StreamClient ──► TranscriptStore ──► sidecar note   (fs write, append)
        |
        | trigger policy
        v
  EnhanceRunner ──► AgentClient.query() ──► structured section array
  (two tiers)       (Claude Agent SDK or         |  (schema-enforced + zod)
                     ordinary LLM API)           v
                                          NoteSink.write()
                                                 |
                                    MarkdownNoteSink (reference impl)
                                                 v
                                        BlockWriter ──► meeting note on disk, only
                                                        inside the shorthand:ai markers
```

**The destination is a port, not a path.** `EnhanceRunner` takes a `NoteSink` rather than a
note path, a vault root, and three injected file functions. `MarkdownNoteSink` is the
reference implementation; an API-backed target (etag for revision, `409` for stale, `429` for
busy) is expressible without core learning anything about it. Revision is opaque to core, and
`read()` returns sections, user notes, and revision from one observation so they cannot skew.
The full contract is [`CONTRACT.md`](CONTRACT.md).

**The agent is a port too, and the second implementation proved it.** `AgentClient` was
already public and transport-neutral: it accepts a prompt, system prompt, output schema and
optional session id, then returns structured output and a session id. `LlmAgentClient` plugs
ordinary OpenAI, Anthropic and OpenAI-compatible APIs (including a local Ollama endpoint) into
that seam through the Vercel AI SDK; `ClaudeAgentClient` remains the default. Nothing in
`EnhanceRunner`'s scheduling, the `queryForSections` corrective retry loop, `NoteSink`, the
section schema, or `validateSectionOutput` had to split by provider. That is the evidence that
the seam describes enhancement transport rather than merely wrapping one SDK.

**One entry point, enforced by `exports`.** Consumers import `shorthand-core` (and
`/markdown`, `/testing`) — never a deep path. The `exports` map in `package.json` is the
enforcement; there are deliberately no tsconfig `paths`, which would defeat it. Entry points
are explicit named re-exports, never `export *`: a barrel would pull incidental modules into
an already ~7 MB plugin bundle and silently widen the public surface. Block-format internals (`readCurrentBlock`, `writeSections`, `hashBlock`,
`parseSections`, the marker constants) and test seams stay private, because exporting them
re-creates exactly the coupling the sink port removed.

**The split happened, and cost what the exports map promised.** The plugin was extracted to
its own repository because Obsidian's documented dev loop assumes the repo root *is* the
plugin — every in-repo alternative (copy script, junction) was an adaptation. Because the
`exports` map already carried the boundary, extraction was a directory move plus a dependency
line: no import in core changed except its own package name. `./plugin-ui` — Obsidian settings
and a status reducer parked under `src/` — was never core's contract and went with the plugin.

A multi-package **workspace** (`packages/`) remains deferred, not cancelled. Revisit when the
API sink actually exists, so a package boundary is designed against two real consumers rather
than one hypothetical one. The consumer that exists today is a separate repo, and a git tag is
the version boundary between them.

## Invariants — do not weaken these

**Ownership.** The plugin only ever replaces text strictly between `<!-- shorthand:ai:start -->`
and `<!-- shorthand:ai:end -->`. User text is never touched. Marker anomalies (zero, duplicate,
nested, inverted) **fail closed** — no write at all, rather than a guess.

**The agent has no write tool.** `options.tools` never contains `Write`/`Edit`/`Bash`, which
removes them from its context entirely. The only mutation path is our code. Vault reads are
confined to the vault by a `canUseTool` guard.

**Vault lookup requires a capability on both sides of the seam.** A sink's `agentContext`
says that the note has a searchable corpus; it does not prove that an agent client can drive
`Read`/`Glob`/`Grep`. `AgentClient.supportsVaultTools` therefore defaults by absence to yes,
preserving every pre-existing client, while `LlmAgentClient` declares false. The runner
downgrades every pass through that backend to the tick tier — including the requested closing
link pass — and withholds `cwd` as well as the tools. The user-visible cost is plain: notes
produced by the LLM backend will **not** reference people, projects or prior meetings found
elsewhere in the vault, because that backend performs no vault reads. Putting this choice on
the client rather than asking consumers to omit `vaultRoot` prevents a forgotten omission
from silently shipping tools and a vault path to a client that cannot honour them.

**Provider credentials stay outside the document they unlock.** `llm-credentials.json` lives
in `shorthandConfigDirectory()`, following `google-credentials.json` exactly. Core reads it
and never writes it; the consumer is the sole writer, and `shorthand-core/testing` exports an
executable conformance suite that writer must satisfy. It is deliberately not an Obsidian
settings field: `data.json` is plaintext and travels with vault sync, which would copy a
billable API key to every synced machine and every vault backup. Provider, model, `base_url`
and key share one file because they have one owner and one write moment; splitting the
non-secret selection into a sibling file would create a torn profile between two writes.

**The safety preamble is not the caller's to replace.** The system prompt is composed at one
site (`runner.ts`) as `ENHANCEMENT_SAFETY_PREAMBLE` + the editorial guidance, in that order.
Only the second half is caller-supplied, through `EnhanceRunnerOptions.guidance`; an empty or
whitespace-only value falls back to `DEFAULT_EDITORIAL_GUIDANCE`, because a prompt carrying
safety rules and no editorial instruction produces baffling notes and raises no error to
explain them. Nothing a caller supplies can drop the untrusted-data framing, the marker-token
ban, or the "the given sections are authoritative" instruction — and `test/enhance-runner.test.ts`
asserts the composed prompt over the custom-guidance path, not just the default one. Note
*quality* is not guarded and is not meant to be: a bad prompt makes bad notes, which is the
caller's business. `MAX_GUIDANCE_CHARACTERS` is hygiene against a pasted-in novel, enforced by
the surface that accepts the text rather than by the runner.

**Writes are read-splice-write.** Every write re-reads from disk, locates markers in *that*
content, replaces only the block body, fsyncs a temp file, and renames over the target.
Offsets are never carried across an `await`.

**Optimistic concurrency.** The block hash observed at pass start is re-checked at write
time; a mismatch discards the agent result and re-queues rather than overwriting.

**Claude passes resume one Agent SDK session per capture.** Every pass after the first sends
`resume: <sessionId>` — never `forkSession`, so there is no session branching — which lets the
model carry its own reasoning forward instead of re-deriving it from a bare snapshot on every
tick. This does **not** make the SDK session the source of truth: the full current section
array and only the transcript delta since the last pass are still resent on every pass
regardless of what the session remembers, and `ENHANCEMENT_SAFETY_PREAMBLE` explicitly tells the
model that the sections it was given are authoritative when they disagree with its memory of
earlier passes — the note stays authoritative, the session is memory, not state.

The AI SDK backend is stateless at the provider boundary — there is no resume — so
`LlmAgentClient` owns a `ModelMessage[]` per instance and resends that history instead. The
same "memory, not state" rule still applies: every pass independently includes the full
current sections and the transcript delta, and the safety preamble says those sections win
over remembered turns.
Owning the array buys an explicit trim policy that provider-side resume does not: a character
budget drops whole user+assistant pairs from the oldest end, never half a pair. The system
message is structurally outside that budget and can never be evicted; otherwise trimming
could silently remove the safety preamble while leaving an apparently healthy pass. The
current pass's user message is inside the trimmed array and can be evicted from future history
under a tight budget, but only after the call that used it has already completed.
By contrast, Agent SDK resume delegates storage to the `claude` CLI and grows toward its
auto-compaction path, which remains untested here as described below.

This reverses an earlier documented decision, not an accidental regression of one: see
`docs/original-plan.md`'s "Enhancement passes: stateless and bounded (Codex blocker 3)" for the
original rejection, which is left in place rather than deleted. That objection — a resumed
session grows context at least linearly across passes while re-sending snapshots and
accumulating tool results, and prompt caching lowers unit price, not context size — is real and
is **not** solved by this change. What changed is that a capture is now bounded by the
wall-clock window (`maxDurationMs`, 4h by default — see "Known limitations" below), so "grows
at least linearly" now has a ceiling instead of none: worst case is roughly 4h / 90–576
accumulated passes of session history for one capture, not the previously-unbounded growth the
original rejection was guarding against. Accepted as a deliberately unmitigated cost: the
enhancement session's own context can still grow large over a very long capture and may trigger
the SDK's own auto-compaction, a path this branch's test suite does not exercise. A live-capture
check is worth doing before or shortly after this ships, but it is not a blocking condition.

One more consequence worth stating rather than leaving implicit: once the wall-clock window
expires, the final `enhanceNow("link")` pass that would otherwise run on capture-stop is also
skipped, not just live ticks — so a capture that runs past the window loses its closing summary
pass, the single bounded call least likely to itself be a runaway. This is consistent with
"capture continues without enhancement" (see "Known limitations" below), and the window is
generous (4h by default), but it is a real cost of the expiry check being unconditional.

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
  it is sticky, because the malformed sections get fed back on the next pass. The extractor
  that fixed it is gone: the Agent SDK now returns the section array as structured output, so
  there is no fence to find and no Markdown for a regex to collide with. The finding is kept
  because it is the reason a hand-rolled extractor must not come back.
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
  required, but Shorthand's protocol added both timestamp fields *without* a version bump, so an
  older Shorthand dropped every event while the protocol check still passed.

## Known limitations

- **Unsaved-buffer race.** If the note is open in Obsidian with unsaved keystrokes, Obsidian's
  buffer wins on its next save and an AI update can be lost. The failure direction is the safe
  one — an AI update is lost, never user text — and the hash check re-queues.
- **Residual external-write window.** Between the verify-read and the rename, a foreign writer
  cannot be excluded with plain filesystem primitives. Our own processes serialise with a lock
  file.
- **No enhancement pass or USD budget.** Both were tried and removed. Under Claude
  subscription authentication `total_cost_usd` is commonly `0`, so a USD cap never trips —
  and a raw pass count can't tell a long meeting from a runaway loop, so it punished
  the former to guard against the latter. The interval gate (`minIntervalMs`) is the
  real rate bound: even a failing pass respects it, so passes can't fire faster than
  once per interval. A wall-clock window (`maxDurationMs`, 4h by default) is the
  loop-breaker backstop, stopping enhancement only if a capture runs unreasonably long.
- **Shorthand pastes into the focused app.** If Obsidian has focus while capturing, transcription
  lands in the note body as well as the sidecar. That is Shorthand's own behaviour, not this
  plugin's.

## Verification

`bun test` (unit), `bun run typecheck`, `bun run test:e2e` (headless end-to-end using the fake
transcript stream and agent stub). CI runs all of it offline — no Shorthand, vault, or credentials
required. See `README.md` for commands and `.github/workflows/` for the pipeline.

**The conformance suites are shipped API, not tests.** They are exported as
`shorthand-core/testing` and import no test runner: scenarios are plain async functions that
throw, plus thin adapters that take a caller's `describe`/`test`. That inversion is deliberate
— the artifact defining a contract must be runnable by a second package, a different runner
(Vitest, `node:test`), or a consumer in another repo, not only by `bun test` in this repo.
`test/markdown-sink.test.ts` runs `MarkdownNoteSink` through the sink suite; writers of the
Google and LLM credentials files run their respective suites from the owning consumer. Every
future sink and credentials writer must pass its contract unchanged.

**Two checks left with the plugin, and that is correct.** The bundle-load test — which
`require`s the built `main.js` under a stub `obsidian` and asserts a size ceiling — now lives
in the plugin repo, where the bundle is. It exists because CI once built the bundle and never
loaded it, which is how the load-bearing `import.meta.url` banner in the esbuild config came
to exist after a real Obsidian load failure with everything green. `consumer-imports.test.ts`
was deleted outright: it caught a *relative* import escaping a consumer root, a hole `exports`
cannot see — but with the consumer in another repo there is no root left to escape, and a
relative path can no longer reach core at all.

**Releases are the plugin repo's job now.** Obsidian identifies a release by a bare `x.y.z`
tag equal to `manifest.json`'s `version`; BRAT treats that tag as the source of truth and
overrides the manifest on a mismatch. That machinery moved with the plugin. Core carries no
`x.y.z` release of its own — its tags exist only as dependency pins for consumers.
