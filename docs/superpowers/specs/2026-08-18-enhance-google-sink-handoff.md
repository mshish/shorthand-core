# Handoff: wiring `enhance` to a Google Docs sink

**Status: not a spec, not a plan — a state-of-the-world note for whoever (or whichever session)
picks this up next.** No brainstorming has happened on this specific piece yet. Read this, then
run the `superpowers:brainstorming` skill on it — don't skip straight to a plan.

## What exists today (merged, tested, working)

Two PRs landed on `main` (both against `shorthand-core`):

- **#1** — `GoogleDocsNoteSink` itself: `read()`/`write()` against `docs/CONTRACT.md`, the
  markdown→Docs renderer, the `TokenProvider` port, `FileTokenProvider`, and
  `shorthand-notes google-login` (Picker-based: user picks an existing Doc).
- **#2** — `shorthand-notes google-login --create` (app creates its own Drive folder + container
  Doc instead of picking one), plus a token-caching fix.

All of this lives under `src/google/` and is re-exported from `shorthand-core/google`
(`src/google.ts`). Full design context: `docs/superpowers/specs/2026-08-18-google-docs-sink.md`
(the original design plus its "Phase 1c addendum" for `--create`).

**What you can do right now, from a terminal:** run `google-login` (either flow) and get a
`google-credentials.json` file with a `refreshToken` + `documentId` (+ `folderId` if you used
`--create`). That's it. Nothing else in the CLI reads that file.

## The gap this handoff is about

`shorthand-notes enhance` — the command that actually runs an `EnhanceRunner` pass and writes
AI-generated sections somewhere — **only ever constructs a `MarkdownNoteSink`**:

```
bin/shorthand-notes.ts:330  sink: new MarkdownNoteSink({ notePath: note, vaultRoot: vault }),
```

inside `createEnhanceRunner` (called by `runEnhance`, `bin/shorthand-notes.ts:286`). There is no
`--sink` flag, no branch, nothing. Both PR descriptions call this out explicitly as out of scope.
Google Docs' whole reference implementation exists and is tested against fakes, but nothing in
this repo drives a real end-to-end write to a real Google Doc.

## Concrete pieces missing before `enhance` could use `GoogleDocsNoteSink`

1. **No `tabId` ever gets created.** `GoogleDocsNoteSink` needs `{ documentId, tabId }`.
   `documentId` (and `folderId`) come from `google-login`. `tabId` comes from `addDocumentTab` —
   the spec's "Meeting start" step — and **nothing in this codebase calls it**. This was
   deliberately deferred in the original spec as "Task 11," which itself was never run (see next
   section). Whoever builds this needs to decide where "create this meeting's tab" happens: a new
   CLI step (`capture --sink google`? a separate `init-tab` command?), or something the future
   setup app does before ever invoking core's CLI.
2. **No sink-selection mechanism in `enhance`/`capture` at all.** Needs a design decision, not just
   an implementation — see "The real open question" below before building anything.
3. **Live verification has never happened.** The spec's four empirical open questions (does
   loopback+`trigger_onepick` really work — *this one is now confirmed yes, verified interactively
   this session*; does `addDocumentTab` behave as documented against a real doc; does writing every
   ~25s for an hour bury a human's Version History; does `about.get` return the user's email under
   `drive.file` alone) are still unverified except the first. `addDocumentTab` in particular is
   exactly the next thing standing between here and a real end-to-end write — confirming it against
   a real document and wiring up `enhance` are naturally the same piece of work.

## The real open question — resolve this first, before any implementation planning

`docs/superpowers/specs/2026-08-18-setup-config-app-brief.md` (the not-yet-built setup/config
desktop app) already frames **"let the user pick which integrations/outputs they want (Obsidian
plugin, Google Docs) and install/configure each"** as *that app's* job, not core's CLI. That app
doesn't exist yet, and might not for a while.

So the actual design question a fresh brainstorming session needs to answer is: does
`shorthand-notes enhance`/`capture` grow a real `--sink google` flag (and become the thing the
not-yet-built app eventually shells out to, the same way it already shells out to the Markdown
path), or does core's CLI stay Markdown-only forever and a Google Docs capture only ever happens
through a *library* consumer (someone constructing `EnhanceRunner` + `GoogleDocsNoteSink` directly
in their own code, never through `bin/shorthand-notes.ts`)? This changes the shape of everything
else — CLI flags vs. no CLI flags, whether `tabId` acquisition belongs in `bin/` at all — so it's
worth deciding deliberately rather than defaulting into an answer.

## Relevant files to read (in this order)

1. `docs/superpowers/specs/2026-08-18-google-docs-sink.md` — full design + the Phase 1c addendum.
2. `docs/superpowers/specs/2026-08-18-setup-config-app-brief.md` — why sink-selection might not
   belong in core at all.
3. `src/google/docs-sink.ts` — what `GoogleDocsNoteSink` actually needs to be constructed.
4. `bin/shorthand-notes.ts:286-345` (`runEnhance`/`createEnhanceRunner`) — the exact gap.
5. `docs/CONTRACT.md` — the `NoteSink` contract itself, if this is your first time in this codebase.

## Not part of this handoff (already tracked elsewhere, don't re-derive)

- `folderId` merge-semantics bug (stale `folderId` surviving a picker re-login) — real, deferred,
  becomes load-bearing only when a per-meeting-docs-in-a-folder feature (spec's 1d) gets built.
- Various Minor findings from both PRs' final reviews (doc-comment precision, test-double typing) —
  recorded in each PR's description, none affect correctness.
