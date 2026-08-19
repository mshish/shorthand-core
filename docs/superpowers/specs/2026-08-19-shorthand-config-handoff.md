# Handoff: starting `shorthand-config`

**Status: handoff note for a fresh session. Not a spec, not a plan.** It records what already exists
and what changed since the existing brief was written. Scope is settled — see below — so this is not
a "resolve an open question first" handoff like the Google-sink one; it's "go build the brief."
`shorthand-config` has not been scaffolded. Nothing in this repo creates it.

## What landed just before this handoff

`shorthand-core` merged PR #3 (`enhance-google-sink`, commit `bb75be7` on `main`): `GoogleDocsNoteSink`
is now reachable from the CLI via `shorthand-notes capture --enhance --sink google` /
`shorthand-notes enhance --sink google`. Full detail:
`2026-08-19-enhance-google-sink-design.md` and `2026-08-19-enhance-google-sink-handoff.md`.

**The practical consequence for this handoff:** the only way to reach that code path today is to
hand-write a `google-credentials.json` using an existing refresh token and the OAuth client that
issued it (the "testing unlock" described in the enhance-google-sink handoff). There is no real
consent flow. That is what `shorthand-config` is for.

## Read in this order

1. This file.
2. `2026-08-19-shorthand-config-app-brief.md` — the existing brief. **Long, thorough, and already
   answers most of the mechanical questions** (the six-step user-facing auth flow, the file-by-file
   Rust port reference, eight non-obvious rules that must survive the port, the credentials-file
   contract, the scope guard, update distribution). Read it in full before writing any code — it is
   the single source of truth for *how* the consent flow works. Do not re-derive any of it.
3. `2026-08-19-google-oauth-boundary-design.md` — what core guarantees on its side of the boundary
   (the companion document the brief itself points at first).

## Correction to the existing brief

The brief's header currently says *"Not committed to git — written to disk only, at the user's
request, until reviewed."* That is now stale: it was committed in `b6f30aa` along with the other
specs behind the Google work, and has sat there since without a recorded review. Don't take the
"awaiting review" framing as still accurate — but don't take silence as approval either. If a fresh
session is about to act on a specific claim in the brief that looks load-bearing and surprising,
confirm it with the human rather than assuming it was blessed by the passage of time.

## Scope: settled, do not re-open

An earlier draft of this handoff raised whether v1 should be trimmed down given there's currently one
owner and one user, rather than the brief's assumed non-technical paid-product audience. **The human
has explicitly closed that question: proceed with v1 exactly as the existing brief scopes it** — the
installable artifact, the auto-updater, and the Google consent flow, all three. The architecture in
the brief is correct and is not up for re-litigation. A fresh session should not re-raise this; treat
the brief's "v1 scope" section as final and start building toward it.

**What's still genuinely open** is implementation-level, not scope-level — the brief's own "Open
questions" section (its numbered list 1-7): whether `bun build --compile` works on macOS, where the
OAuth client id/secret live in a Tauri build, Linux packaging, whether this app supervises a
background process, bundle-vs-install for `shorthand-core`, and the UNVERIFIED signing/updater facts
that "change the CI design if they are wrong." Those are legitimate `superpowers:brainstorming` /
research territory for a fresh session — the scope question is not.

## Settled — do not re-derive

Everything in the brief's own body stands: the one-way dependency (`shorthand-config` depends on
`shorthand-core`, never the reverse), the six-step user-facing auth flow, the file-by-file Rust port
map and its eight non-obvious rules, why `client_id`/`client_secret` live in the credentials file,
why this app registers its own Google Cloud OAuth client (and the re-consent consequence), the scope
guard's required adaptation for Rust, and the credentials-file contract (defined in the boundary spec,
not restated here).

## Not part of this

- Any code changes to `shorthand-core` — this is a new, separate repository
  (`mshish/shorthand-config`), not yet created.
- The transcription app, the Obsidian plugin, agent-backend selection, licensing/entitlement UI,
  telemetry — all explicitly deferred past v1 in the existing brief, and nothing in this handoff
  changes that.
