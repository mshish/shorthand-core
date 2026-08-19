# Google Docs `NoteSink` — design

**Status: approved design, ready for an implementation plan (`writing-plans`). Not yet
implemented. Not committed to git — written to disk only, at the user's request, until reviewed.**

## Context

`shorthand-core` currently has one `NoteSink` implementation, `MarkdownNoteSink`, writing to an
Obsidian vault. Google Docs is the next output target, and the first of several planned API-based
integrations (the port was explicitly designed for this — see `docs/CONTRACT.md`, which describes
itself as written for "an API-backed target — Notion- or Granola-shaped").

Rollout is staged, and **this spec covers only the first two stages**:

- **1a** — the user selects an *existing* Google Doc via the Google Drive Picker.
- **1b** — each meeting becomes a new **tab** inside that doc, via the Docs API's tab support.
- 1c (app creates the container doc) and 1d (per-meeting docs in a folder) are later increments
  on the same sink and are explicitly out of scope here.

This document assumes the reader has `docs/DESIGN.md` and `docs/CONTRACT.md` for background on
core's architecture and the `NoteSink` contract; it does not repeat that material except where
this sink needs something the contract doesn't already specify.

## Why tabs simplify this sink relative to `MarkdownNoteSink`

The Markdown sink needs invisible marker-comment tokens because AI-owned content and the user's
own prose share one buffer, and a write must touch only the AI-owned region. With one tab per
meeting, **the whole tab is AI-owned** — the user's own notes live in other tabs (or the container
doc, in a later stage). So the marker-token machinery does not need to exist in this sink at all:
a write is "delete the tab body, rewrite it," full stop.

## Package layout

Follows the existing pattern from `docs/CONTRACT.md` §1, where Markdown-specific code lives at
`shorthand-core/markdown` and never leaks into the root entry point.

| Specifier | Contains |
| --- | --- |
| `shorthand-core/google` (new) | `GoogleDocsNoteSink`, the markdown→Docs-requests renderer, tab-management helpers, and the reference `FileTokenProvider` (below) |
| `shorthand-core` (root, gains one export) | `TokenProvider` — a new, transport-neutral port (below) |
| `bin/shorthand-notes.ts` (existing CLI, gains one subcommand) | `google-login` — the reference OAuth bootstrap (below) |

## The `TokenProvider` port (new)

Core has no browser and performs no OAuth or Picker consent flow itself — this follows the same
principle already established for `NoteSink.agentContext`: core is headless and never grows a
setup UI. `TokenProvider` is the credential equivalent of the sink port: an interface core
consumes, never an implementation core owns.

```ts
export interface TokenProvider {
  getAccessToken(): Promise<
    | { ok: true; token: string }
    | { ok: false; error: TokenError }
  >;
}

export type TokenErrorCode = "not-authorized" | "revoked" | "transport";
export type TokenError = Readonly<{ code: TokenErrorCode; message: string; cause?: unknown }>;
```

- `not-authorized` — no credential is available yet (never consented, or consent was never
  completed). The sink should surface this as `forbidden` on read/write, same as any other
  auth failure per `CONTRACT.md` §4.
- `revoked` — a credential existed but Google rejected it (`invalid_grant`). This is not
  retryable by core; it needs new consent from whatever obtained the original one.
- `transport` — refreshing the token itself failed for network reasons; retryable.

**How a credential gets into a `TokenProvider` is a consumer concern in general**, but this sink
ships one such consumer itself — the CLI bootstrap below — for the same reason `MarkdownNoteSink`
ships as the reference `NoteSink` rather than being left for someone else to write: without it,
this sink cannot be used, tested, or self-hosted before the (separate, not-yet-built) setup app
exists. The setup app is expected to ship its own, second `TokenProvider` implementation later,
backed by the OS keychain instead of a file — same interface, different storage, exactly the
`NoteSink`-style "one port, multiple implementations" pattern already established in this codebase.

### CLI bootstrap: `google-login` and the reference `FileTokenProvider`

A new subcommand on the existing CLI, `shorthand-notes google-login`, following the precedent set
by `docs/CONTRACT.md` §6 that `bin/` is internal to core rather than an external consumer — the
same standing that already lets `bin/shorthand-notes.ts` call the block writer directly.

What it does, all of it already covered by the verified facts above — nothing new to prove:

1. Opens the system browser to Google's OAuth authorization URL with `scope=drive.file`,
   `access_type=offline`, `prompt=consent`, a PKCE challenge, and `trigger_onepick=true` so the
   same flow that grants access also lets the user pick the target doc.
2. Starts a short-lived local HTTP listener on `http://127.0.0.1:PORT` to catch the redirect,
   which carries both the auth `code` and `picked_file_ids`.
3. Exchanges the code (+ PKCE verifier) for tokens at Google's token endpoint.
4. Writes the refresh token and the picked document id to a local file — not the OS keychain,
   which is more machinery than a CLI/self-hosted path needs, and not an env var, which doesn't
   persist across runs without the user re-exporting it every session. A `chmod 0600` JSON file
   under the same config directory `detectShorthandExecutable`-style platform resolution in
   `src/config.ts` already establishes conventions for (e.g. alongside wherever `DEFAULT_CONFIG`
   points) is the right level of ceremony — reuse that existing platform-path logic rather than
   inventing a second convention for where Shorthand config lives.

`FileTokenProvider` is the corresponding `TokenProvider` implementation: reads that file,
exchanges the refresh token for an access token, re-reads on `revoked`/expiry rather than caching
indefinitely.

**This is not only a development shim.** It's the standing answer to a question the licensing
plan already commits to: what does a self-hosted or non-paying user do, forever, without the
installer? `bin/shorthand-notes` already drives the Markdown sink headlessly without Obsidian;
`google-login` does the same job for the Docs sink without the setup app. It also happens to be
how prototype question 1 below gets answered — building the bootstrap command *is* the loopback +
`trigger_onepick` prototype, not a separate throwaway script.

## The sink

### `read()`

One `documents.get?documentId=…&includeTabsContent=true` call. `includeTabsContent=true` is
required — without it, `document.tabs` is empty and only the legacy first-tab fields populate,
which is the wrong shape for a multi-tab document.

- Capture `document.revisionId` as the sink's `revision` (§2.1 of `CONTRACT.md`: one observation,
  sections + notes + revision together).
- Locate the owned tab by a `tabId` persisted locally from this meeting's `addDocumentTab` call
  (see below) — never by position or title.
- Return `{ sections, userNotes, revision: revisionId }`.

### `write()`

One `batchUpdate` call per pass, containing, **in descending `startIndex` order**:

1. `deleteContentRange` over `{ tabId, startIndex: 1, endIndex: bodyEnd - 1 }`. The API forbids
   deleting a Body's final newline character, hence `bodyEnd - 1`, not `bodyEnd`.
2. `insertText` at `{ tabId, index: 1 }` with the full re-rendered plain text.
3. The styling requests the renderer produced for that text (`updateParagraphStyle`,
   `createParagraphBullets`, `updateTextStyle` — see Renderer below), each targeting a range in
   the text just inserted.

Google's documented rule ("write backwards" — see the Docs API's request/response and
insert/delete/move-text guides) is that requests in one `batchUpdate` are applied in array order
and later requests see earlier requests' index shifts. Sorting descending means each request's
own indices are unaffected by the ones ahead of it in the array. **Do not split this across
multiple `batchUpdate` calls** — it loses atomicity (a partial failure could leave the tab in a
mixed state, which the ownership invariant in `CONTRACT.md` §3 forbids) and doubles quota
consumption for the same amount of work.

**Invariant, enforced in code, not just by convention:** every request in the array must carry an
explicit `tabId`. Omitting it silently targets the *first* tab in the document — plausibly the
user's own notes — with no error from the API. The request builder should assert this before
sending, e.g. throw if any request in the constructed array lacks a `tabId`, rather than relying
on every call site remembering.

### Concurrency

Use `writeControl.targetRevisionId`, not `requiredRevisionId`. `revisionId` is scoped to the whole
`Document`, not the individual tab — so with `requiredRevisionId`, any collaborator typing in *any*
tab (not just the one being written) would 400 the write. `targetRevisionId` merges the write
against intervening collaborator changes instead. Treat the resulting 400 (when it does happen —
Google notes the merge window can be short on frequently-edited documents) as an expected,
retryable condition: map it to `{ status: "stale" }` and let core's existing requeue logic handle
it exactly as it already does for the Markdown sink's hash-mismatch case.

### Error mapping

Follow `docs/CONTRACT.md` §4 verbatim — this sink adds nothing new to that table:

| HTTP | `write()` result | `read()` error code |
| --- | --- | --- |
| `409`/`412` (incl. `targetRevisionId` merge failure) | `{ status: "stale" }` | — |
| `429` | `{ status: "busy", retryAfterMs }` from `Retry-After` (seconds → ms) | `busySinkError(...)` |
| `401`/`403` | `{ status: "error", error: sinkError("forbidden", …) }` | `forbidden` |
| `404` | `{ status: "error", error: sinkError("not-found", …) }` | `not-found` |
| `5xx`, timeouts | `transport` | `transport` |

Use the exported `sinkError`/`busySinkError` helpers from `src/note/sink.ts` rather than
hand-written object literals — they get `exactOptionalPropertyTypes` right.

### Meeting start (once per meeting, not per pass)

Call `addDocumentTab` with a generated title (e.g. the meeting's date/time), persist the returned
`tabId` in the capture's local state alongside the document id. This is the one call in the whole
sink that happens outside the read/write pass loop.

### The markdown → Docs renderer (new module — the largest net-new piece of work)

The Docs API has no markdown import path for programmatic writes: `insertText` inserts literal
characters, it does not parse markdown syntax, and `replaceNamedRangeContent` only accepts plain
text. Every heading, bullet, bold run, and link has to be emitted as an explicit styling request
alongside the plain text.

Given a `Section[]` (the same type `MarkdownNoteSink` consumes), the renderer's job is to produce:
a single plain-text string, plus a list of `(range, style)` tuples locating headings, bullets, and
inline runs (bold, links) within that string. The sink then converts those tuples into
`updateParagraphStyle` / `createParagraphBullets` / `updateTextStyle` requests, each carrying the
`tabId` and positioned correctly for the descending-order batch.

**Must be UTF-16-aware.** Docs API indices are UTF-16 code units; a character outside the BMP
(most emoji) consumes two indices. A renderer written against `.length` on a JS string is already
correct here (JS strings are UTF-16), but range math built any other way (e.g. iterating grapheme
clusters or Unicode code points) will silently misalign every style request after the first
multi-unit character. Test fixtures should include at least one emoji in section content.

### Scope invariant

Request **only** `https://www.googleapis.com/auth/drive.file`, and never combine it with another
scope in the same grant (the desktop Picker flow enforces this anyway — it rejects combined-scope
requests). Do not widen to `documents`, `drive`, or `drive.readonly` for any reason, including a
future convenience (e.g. "search for the doc" wanting `drive.readonly`) — that reclassifies the
whole product into Google's sensitive/restricted OAuth review tier, which brings mandatory
verification, a 100-new-user cap until verified, and (for restricted scopes) an annual third-party
CASA security assessment. `drive.file` alone avoids all of this: Google's own guidance states
"Since drive.file is non-sensitive, an additional security assessment will not be necessary."

Recommend a CI check (a grep over the consumer/installer code for `googleapis.com/auth/` strings
other than `drive.file`) rather than relying on code review alone to catch scope creep — the cost
of getting this wrong later is large and the check is cheap.

### Conformance testing

Implement a `SinkHarness` (per `docs/CONTRACT.md` §5.3) against a fake Docs server test double,
and run `describeNoteSinkConformance` from `shorthand-core/testing` — the existing,
runner-independent mechanism needs no changes to accommodate this sink. Follow the pattern already
established in `test/markdown-sink.test.ts`. `makeBusy()` is mandatory (§5.3: "the most
transport-specific behaviour in the port"). `foreignSnapshot()` should assert that tabs other than
the owned one are untouched by a write — the ownership invariant (§3) applied to this transport.

## Explicitly out of scope for this spec

- The entitlement/billing vendor and its integration.
- The `AgentClient` multi-backend cleanup (`src/agent/contract.ts` currently has some
  Claude-Code-shaped fields — `tools`, `settingSources`, `pathToClaudeCodeExecutable` — on an
  otherwise transport-neutral interface; real future work, deliberately deferred to its own
  design pass when a second agent backend is actually being built).
- The setup/config app itself, and its keychain-backed `TokenProvider` implementation — only the
  contract it must satisfy is specified here (the `TokenProvider` interface, already implemented
  once by the file-backed reference above). See the companion brief,
  `2026-08-18-setup-config-app-brief.md`.
- Stage 1d (per-meeting docs in a folder) — see the "Phase 1c addendum" below for 1c, which is now
  in scope.
- Google Workspace Marketplace listing / domain-wide install (phase 2).

## Phase 1c addendum: app-created container doc in an app-owned folder

Added after 1a/1b shipped, once real end-to-end testing against a live Google account surfaced the
next want: skip picking an existing doc and have the app create + own its own container doc, inside
its own folder, so the setup flow needs zero pre-existing Drive state from the user.

**Scope stays `drive.file`, unchanged.** A folder or file the app *creates* is already covered by
`drive.file` — this is not the hidden, unshareable `drive.appdata` "Application Data folder" (that
scope is for app config data the user should never see or open; explicitly the wrong tool here,
confirmed against Google's own docs). A folder created via the Drive API under `drive.file` is a
completely ordinary, visible "My Drive" folder — the user can see it, open it, rename it, share it.
The app has access to it, and to the doc inside it, purely because it created them.

### `google-login --create`

A new flag on the existing `google-login` subcommand, mutually exclusive with the default
Picker-based flow (1a's existing behavior is unchanged and remains the default):

1. Skip `trigger_onepick` entirely — a plain `drive.file` consent grant, same loopback+PKCE
   round-trip already built, no Picker step (nothing to pick; the app is about to create the
   target itself).
2. If saved credentials already carry a `folderId`/`documentId` from a prior `--create` run, reuse
   them — do not create duplicates on a second run.
3. Otherwise: create a folder via the Drive API (`drive.files.create`, `mimeType:
   "application/vnd.google-apps.folder"`, default name "Shorthand Meeting Notes" — the user can
   rename it afterward in Drive without breaking anything, since the app tracks it by ID, not
   name). Then create the container doc via the Docs API (`documents.create`, default title
   matching the folder), and move it into the folder via the Drive API — the Docs API's
   `documents.create` has no `parents` field of its own; placing a doc in a folder is a
   Drive-API-level operation regardless of which API created the file. **The move must use both
   `addParents` and `removeParents`, not `addParents` alone**: Google's own documentation for
   `files.update` is explicit that "a file can only have one parent folder... update requests must
   use the `addParents` and `removeParents` parameters to modify the parents list." Every file this
   flow touches already has a parent — a freshly-created doc is parented to My Drive root, and a
   picker-selected pre-existing doc is parented wherever the user already keeps it — so fetch the
   file's current `parents` first (`files.get(fileId, {fields: "parents"})`) and pass that as
   `removeParents` on the same `files.update` call. Omitting `removeParents` either fails the
   request or produces a multi-parent state Google explicitly does not support.
4. Persist `{refreshToken, folderId, documentId}` (extends today's `{refreshToken, documentId}` —
   `folderId` is new, optional, absent for the picker-based 1a flow).

`GoogleDocsNoteSink` itself is entirely unaffected — it only ever consumes `documentId`/`tabId`,
never `folderId`. This addendum only changes how those IDs get obtained.

## Follow-up fix: token caching was accidentally defeated, not missing

Found during real end-to-end testing: `google-auth-library`'s `OAuth2Client` already has token
caching built in (`credentials.expiry_date` / `isTokenExpiring()`) — `FileTokenProvider` defeats it
by constructing a brand-new `OAuth2Client` instance on every single `getAccessToken()` call, so
there is never anything for the library's own cache to hold onto. Fix: hold one `OAuth2Client`
instance in `FileTokenProvider`, built once with the stored refresh token set as its credentials,
and call `getAccessToken()` on that same instance every time. No new dependency, no hand-rolled
cache, no change to the `TokenProvider` port or to how `GoogleApiDocsClient` calls it — purely
internal to `FileTokenProvider`. Verify the installed `google-auth-library` version's actual caching
behavior directly (its source, not just assumed semantics) before relying on it, per this project's
running practice of confirming third-party library behavior rather than trusting memory of it.

## Verified technical facts this design relies on

(Captured here so a fresh reader doesn't need to re-derive them; sourced from Google's own
developer documentation.)

- `drive.file` is classified **non-sensitive** by Google.
- A first-party, non-JavaScript **desktop Picker** exists: appending `trigger_onepick=true` (plus
  optional `allow_multiple`, `mimetypes`, `allow_folder_selection`) to the standard OAuth
  authorization URL opens the system browser to a Picker; the redirect callback carries both the
  auth `code` and `picked_file_ids`. No separate Picker API key or App ID needed. Constraint:
  **only `drive.file` is permitted for this flow, and it cannot be combined with any other scope**
  — meaning identity scopes (`openid`, `email`) need a separate consent flow if account-linking is
  ever needed; this is a consumer/installer-app concern, not this sink's.
- `addDocumentTab` is present in the current Docs API `Request` union (confirmed via the Requests
  and Response references and the generated client) and is not marked Developer Preview — though
  the human-written "Work with tabs" how-to guide is stale and doesn't mention tab creation, so a
  short end-to-end prototype against a real document is worth doing before implementation starts,
  not just trusting the reference docs.
- Desktop OAuth needs no backend: a Desktop-app-type OAuth client is issued a client secret, and
  shipping it in the binary is Google's documented standard path for a public/installed client
  (secret + PKCE + loopback redirect `http://127.0.0.1:PORT` is the whole model — OOB flow is
  dead). No server-side broker is required for the Google side of this feature.
- Quota: 600 writes/min/project, 60 writes/min/user. At a 25s write cadence (1 `get` + 1
  `batchUpdate` per pass = 2.4 writes/min/meeting), the project ceiling is reached around 250
  concurrent meetings — per-user quota has 25× headroom by comparison. Request a quota increase
  well before approaching this (Google recommends applying at moderate utilization, not near the
  limit), and make the write cadence adaptive (skip writes when the rendered output is unchanged
  from what was last written) rather than a fixed interval — this alone likely cuts write volume
  substantially in quiet stretches of a meeting.

## Open questions to resolve empirically before implementation starts

These are cheap (roughly an hour each) and two of them could change the design, so they belong
before writing the sink, not after:

1. **Does `http://127.0.0.1:PORT` loopback actually work combined with `trigger_onepick=true`?**
   Primary Google documentation implies yes ("The Google Picker imposes no additional
   restrictions" on redirect URI choice); scattered third-party writeups claim a public HTTPS
   bounce is required. This is a direct conflict and is load-bearing for stage 1a — resolve it
   first. Building the `google-login` CLI bootstrap (above) against a real Google Cloud test
   project answers this directly; no separate throwaway script is needed.
2. **Confirm `addDocumentTab` end-to-end** against a real document, since both existing
   confirmations trace back to the same generated reference material and the hand-written guide
   is silent on tab creation.
3. **Write to a real Google Doc every 25 seconds for an hour, then open Version History.** Whether
   ~144 automated revisions/hour bury the human's own edit history, or whether Drive's
   revision-merging keeps it usable, is undocumented and could change the write cadence or the
   overall write strategy — a real trust-affecting failure mode if it goes badly, and only
   answerable by trying it.
4. **Does `about.get` return the user's email under `drive.file` alone?** If yes, it resolves the
   "Picker forbids combining scopes with identity" limitation cheaply, without a second consent
   screen, for any future account-linking need.

## Verification (once implementation begins)

1. The four prototypes above, run first.
2. Unit tests for the markdown→Docs renderer: heading levels, bullets, bold/link runs, and
   UTF-16 offset correctness with emoji in the input, all independent of any network call.
3. The conformance suite (`describeNoteSinkConformance`) against the fake-server harness.
4. Manual end-to-end: a real capture writing to a real Doc tab; confirm a concurrent human edit in
   a *different* tab does not break the write (validates the `targetRevisionId` choice in
   practice); confirm the `tabId`-required invariant actually throws when deliberately violated in
   a test, rather than silently succeeding against the wrong tab.
5. Quota sanity check: confirm the adaptive/no-op-skipping write logic is actually in place before
   any pilot beyond a handful of concurrent users.
