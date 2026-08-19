# Handoff: starting `shorthand-config`

**Status: handoff note for a fresh session. Not a spec, not a plan.** It records what already exists,
what changed since the existing brief was written, and the one real open question a fresh session
needs to resolve — via `superpowers:brainstorming` — before any code gets written. `shorthand-config`
has not been scaffolded. Nothing in this repo creates it.

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

## The one real open question

**The brief's v1 scope was written for a different situation than the one that exists right now.**

The brief frames this as *"a separate, proprietary, cross-platform desktop app... [for] a
non-technical individual who already pays for Claude or ChatGPT and has never touched a CLI"* — and
scopes v1 as three substantial pieces: (1) a signed/shippable installable artifact, (2) Tauri's
auto-updater wired end to end including a release pipeline, and (3) the Google consent flow.

Asked directly, the human said: *"we own everything right now and I'm the only user."* There is no
other user yet. Installer signing, notarization, an auto-updater, and a public releases repo are all
real work — the brief itself calls out unresolved costs (macOS Developer ID + notarization,
Azure signing ~$120/yr, several UNVERIFIED Tauri updater facts that "change the CI design if they are
wrong") — and none of it is required to unblock the one thing actually blocking real use today:
**getting a real Google credentials file onto this machine without hand-writing one.**

**This was not decided. It needs the human's answer, via brainstorming, before scope is picked.**
Plausible shapes, not a recommendation:

- **v1 as the brief already scopes it** — build toward the eventual paid product from the start,
  installer/signing/updater included. Argument for: avoids doing the same work twice; the brief's own
  "bundle vs. install" and update-distribution sections assume this is being built toward
  distribution anyway.
- **A minimal slice: just the consent flow, no signing/installer/updater polish.** A `cargo run`
  or `tauri dev` app good enough for the human alone to click through consent and get a real
  `google-credentials.json` on their own machine. Argument for: unblocks real end-to-end verification
  of the just-merged Google sink work today, at a fraction of the cost; signing/updater work is
  provably deferrable (nothing about it is load-bearing for a solo user running a dev build).
- Something in between — e.g. build the real consent flow now, in the real `shorthand-config` repo
  with the real architecture, but explicitly skip code-signing/notarization/the updater/the public
  releases repo until there's a second user to justify them.

Whichever is chosen reshapes the brief's v1 scope section and its open-questions list (several of
which — Linux packaging, the updater's `latest.json` format details, Azure signing eligibility — stop
being urgent if signing/updater is deferred).

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
