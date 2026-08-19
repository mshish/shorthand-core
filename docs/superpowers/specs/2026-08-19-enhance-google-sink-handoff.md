# Handoff: making `GoogleDocsNoteSink` reachable

**Status: handoff note for a fresh session. Not a spec, not a plan.** It records where the work
actually stands, which decisions are settled, and the one gap that still makes the Google Docs sink
unusable. Read this, then run `superpowers:brainstorming` — the remaining design question is real
and has not been answered.

**Supersedes `2026-08-18-enhance-google-sink-handoff.md` entirely.** That note described a world
where `shorthand-notes google-login` existed. It does not any more. Do not follow it.

## What landed (merged to `main`, tagged `0.8.0`)

Core shed the Google OAuth consent flow and became a pure *reader* of a credentials file it never
writes. Thirteen commits, `342 → 354` tests, all four gates green.

Deleted outright: `src/google/oauth.ts` (PKCE, the loopback listener, `buildAuthorizationUrl`,
`exchangeCode`), `src/google/container-doc.ts` (`ensureContainerDoc`), the `google-login` CLI
command, and `writeCredentials`/`mergeCredentials`. A grep of `src/` and `bin/` for
`trigger_onepick`, `picked_file_ids`, `code_challenge`, `oauth2/v2/auth`, `createServer`,
`127.0.0.1` and `google-login` now returns nothing. Core is headless in fact, not just in intent.

The credentials file is now a superset of Google's ADC `authorized_user` format:

```json
{
  "type": "authorized_user",
  "client_id": "…apps.googleusercontent.com",
  "client_secret": "…",
  "refresh_token": "…",
  "document_id": "…",
  "folder_id": "…"
}
```

`type`, `client_id`, `client_secret`, `refresh_token` are required — verified against
`google-auth-library`'s own `UserRefreshClient.fromJSON`, which throws on each by name.
`document_id` and `folder_id` are **optional**, and `tab_id` is **not in this file at all**.
2-space JSON, trailing newline, keys in that order, `0600` on POSIX.

Core publishes that format as runnable conformance scenarios
(`shorthand-core/testing` → `describeGoogleCredentialsConformance`) for the application that will
write the file. Full design: `2026-08-19-google-oauth-boundary-design.md`. The companion app's
brief: `2026-08-19-shorthand-config-app-brief.md`.

## The gap — why the sink still cannot be used

`GoogleDocsNoteSink` requires **both** `documentId` and `tabId` (`src/google/docs-sink.ts:9-14`).
`grep -rn "addDocumentTab" src/ bin/ test/` returns **zero hits**. Nothing mints a `tabId`, and
`createEnhanceRunner` (`bin/shorthand-notes.ts`) still hardcodes `MarkdownNoteSink`.

So the sink is not constructible from any persisted state, and no code path reaches it. Everything
below it is implemented and tested against fakes; nothing drives it.

**This is the whole job.** Two pieces:

1. **Mint a `tabId`** via the Docs API's `addDocumentTab`, once per meeting, and persist it. The
   boundary spec settled only where it does *not* live: not in the credentials file, because a
   single global `tab_id` cannot represent two concurrent meetings, and because one file should
   have one writer. It named `<shorthandConfigDirectory>/captures/<captureId>.json` as the likely
   home but deliberately deferred the schema, the lifecycle, and even whether a file is needed at
   all. **That is a design decision for this session, not a settled fact.**
2. **Let `enhance`/`capture` select the sink.** Today there is no `--sink` flag and no branch.
   Whether one is added, and whether sink construction belongs in `bin/` at all, is open.

## Settled — do not re-derive

- **Core never performs consent.** Obtaining a credential belongs to `shorthand-config`. Core
  defines the file contract and reads it, knowing nothing about what wrote it. Config depends on
  core; core must never depend on config.
- **`client_id`/`client_secret` come from the file**, not from constructor arguments or the
  environment. This is what keeps the dependency one-directional.
- **`document_id` is optional at read time.** Nothing in core reads it off the file — the sink
  takes `documentId` as a constructor option — so requiring it would only make a file unreadable
  for no consumer. Leaves room for "connect now, choose a target later".
- **Both target-selection flows must keep working**: the Picker (`trigger_onepick=true`) and the
  app-created folder + container Doc. Both stay within `drive.file`.
- **Scope stays `drive.file`, never combined with another scope.** `test/google-scope-guard.test.ts`
  enforces it and now fails if the scope string disappears entirely, not only if it widens.
- **`addDocumentTab` works.** Confirmed by the human from their own use and Google's documentation.
  Earlier specs listed this as an open question to prototype — it is not. Do not spend time on it.

## The testing unlock

You do not need `shorthand-config` to build or test this, and you do not need to re-consent.

`client_id`/`client_secret` now come from the credentials file, so a **hand-written file using the
human's existing refresh token together with the OAuth client that issued it** works today. The old
credential is dead only against a *new* OAuth client, and nothing forces one for development.

Write that file at `credentialsPath()` — `<shorthandConfigDirectory>/google-credentials.json`, see
`src/config.ts` — in the shape above, and core will refresh tokens and drive the Docs API against a
real document. That is the fastest path to an end-to-end write, and it is worth reaching early:
everything below the sink has only ever been exercised against fakes.

## Still genuinely open

- **Where per-capture `tabId` state lives, and its lifecycle.** When is a tab created, when reused,
  what happens when the same note is captured twice, and what cleans up.
- **Does `about.get` return the user's email under `drive.file` alone?** Cheap, and would resolve
  the Picker's forbid-combined-scopes limitation without a second consent screen. Not blocking.

## Known and deliberately unfixed

- **`test/agent-contract.test.ts` flakes on Windows** — `EBADF` during temp-dir teardown, roughly
  1 run in 3–5, aborting that file and reporting ~330 instead of 354. Pre-existing, unrelated to
  any of this work. **Re-run before believing a red suite.**
- **The POSIX-permission axis of the credentials contract has never executed**, because this is a
  Windows machine. The `0600` scenario is a declared `todo` and its mutation a declared `skip` —
  visible, not silently passing. If CI is Windows-only, `0600` is asserted by nobody.
- **Conformance forbids extra keys while `readCredentials` tolerates them.** Deliberate and
  documented in both places: the reader is lenient so an older core survives a newer writer at
  runtime; conformance is stricter so adding a field is a coordinated change requiring a new golden
  fixture here.
- **Atomicity is unobservable from outside.** The conformance suite requires the absence of temp
  debris, never write-then-rename itself. A plain truncate-and-write passes. Must be code-reviewed
  in the writing repo, not assumed tested.

## Read in this order

1. This file.
2. `2026-08-19-google-oauth-boundary-design.md` — what core now guarantees and why.
3. `src/google/docs-sink.ts` — what the sink needs to be constructed.
4. `bin/shorthand-notes.ts`, `createEnhanceRunner` — the exact place `MarkdownNoteSink` is hardcoded.
5. `2026-08-18-google-docs-sink.md` — the original sink design. **Its `TokenProvider` and
   `google-login` sections are superseded**; the sink, renderer, error mapping, concurrency and
   scope-invariant sections still stand.
6. `docs/CONTRACT.md` §5.4 — the credentials-file contract, if this is your first time here.

## Not part of this

- `shorthand-config` itself — separate repo, not yet created, its own brief.
- The OS keychain — deferred with a concrete route recorded in the boundary spec; needs core to
  ship as a code-signed binary first. `bun build --compile` was verified working on Windows
  (132 MB, ran a full agent session); macOS and Linux untested.
- Bundle-vs-install for core — still an open recommendation in the boundary spec, unconfirmed.
