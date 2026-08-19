# Design: making `GoogleDocsNoteSink` reachable

**Status: design, reviewed, ready for an implementation plan.** Answers the two questions
`2026-08-19-enhance-google-sink-handoff.md` left open: where the per-capture `tabId` lives and its
lifecycle, and how `enhance`/`capture` select the sink. Read the handoff note first if you have not —
it records what already landed and which facts are settled and must not be re-derived here.

## The gap this closes

`GoogleDocsNoteSink` requires both `documentId` and `tabId` at construction
(`src/google/docs-sink.ts:9-14`). Nothing mints a `tabId`, and `createEnhanceRunner`
(`bin/shorthand-notes.ts`) hardcodes `MarkdownNoteSink`. The sink is fully implemented and tested
against fakes; nothing in the running CLI can reach it.

## Decisions

### 1. Per-capture state is persisted, keyed by a hash of the note path

`<shorthandConfigDirectory>/captures/<captureId>.json`, per the boundary design's already-settled
home for this file (`2026-08-19-google-oauth-boundary-design.md`, "Where per-capture `tabId` state
lives"). Shape:

```json
{ "documentId": "…", "tabId": "…", "createdAt": "2026-08-19T14:30:00.000Z" }
```

Plain camelCase — unlike the credentials file, this file has exactly one writer and one language
(core, TypeScript), so none of the cross-language `snake_case` reasoning in `CONTRACT.md` §5.4
applies.

**`captureId` = SHA-256 hex digest of the resolved, case-normalized note path** (`node:crypto`).
Deterministic: re-running `capture` on the same note after a crash reaches the same id and reuses
the same tab instead of minting a duplicate. Concurrent meetings on different notes get different
ids — the exact collision a single global slot could not represent.

**Windows case fix (required change from review):** `resolveFrom`'s `path.resolve` does not
canonicalize case, and NTFS is case-insensitive but case-preserving. Two invocations of the same
note differing only in path case (e.g. drive-letter case) would otherwise hash to different ids and
silently mint a second tab. Lowercase the resolved path before hashing when
`process.platform === "win32"`; leave it unchanged elsewhere, where the filesystem is
case-sensitive and lowercasing would be wrong (it would collide two genuinely different paths).

Reuse logic: if the state file exists and its `documentId` matches the credentials file's *current*
`document_id`, reuse the stored `tabId`. Otherwise (first run, or the user has since pointed at a
different document) mint a fresh tab and overwrite the file. A state file that fails to parse as
JSON is treated identically to a missing file — mint fresh — because it is a disposable cache, not
authoritative data; this must never surface as an error to the caller.

**Acknowledged and deliberately not built:** when `documentId` changes and a new tab is minted, the
previously-minted tab is left behind in the old document with no cleanup path. This is the correct
behavior (the old tab still holds real meeting content and must not be deleted), but it is worth
recording as a known consequence rather than a silent gap: over time, switching target documents
leaves an orphaned tab per switch in whichever document was previously selected.

### 2. `addDocumentTab` is a new, separate method on `GoogleDocsApi` — not a call through `batchUpdate()`

**Required change from review:** the obvious-looking shortcut — reusing the existing public
`batchUpdate()` method with an `addDocumentTab` request — does not work. `batchUpdate()`
(`src/google/docs-client.ts:104-128`) returns only `{ revisionId }` and errors out unless
`response.data.writeControl?.requiredRevisionId` is present, which a no-`targetRevisionId` tab-mint
call will not populate. The new tab's id instead comes back at
`response.data.replies[0].addDocumentTab.tabProperties.tabId` (verified against
`googleapis`' `docs_v1` types: `Schema$BatchUpdateDocumentResponse.replies: Schema$Response[]`,
`Schema$Response.addDocumentTab: Schema$AddDocumentTabResponse`, whose `tabProperties.tabId` is the
new tab's immutable id and `tabProperties.title` is settable on the request).

Add to `GoogleDocsApi`:

```ts
addDocumentTab(documentId: string, title: string): Promise<DocsApiResult<{ tabId: string }>>;
```

`GoogleApiDocsClient`'s implementation makes its own call to the private `#documents.batchUpdate`
field — `requestBody: { requests: [{ addDocumentTab: { tabProperties: { title } } }] }` — reads
`response.data.replies?.[0]?.addDocumentTab?.tabProperties?.tabId` out, and reuses the existing
`toDocsApiError` helper on the catch branch, exactly like `getDocument`/`batchUpdate` already do.

Tab title: the note's basename with its extension stripped (`basename(note, extname(note))`).

**Required change from review — existing fakes must be updated or `typecheck` breaks:** two test
files construct objects typed as `GoogleDocsApi` without this new member —
`test/google-docs-sink-unit.test.ts:5-14` (`fakeApi()`) and `test/google-docs-sink.test.ts:16`
(`class FakeDocsApi implements GoogleDocsApi`). Both need an `addDocumentTab` stub added as part of
this change, not as an afterthought once `bun run typecheck` fails.

### 3. `resolveGoogleDocsSink()` — new module, mint-or-reuse plus sink construction

New file `src/google/capture-sink.ts`, exported from the `shorthand-core/google` subpath
(`src/google.ts`) alongside the existing pieces:

```ts
export type ResolveGoogleSinkOptions = Readonly<{
  credentialsPath?: string;
  capturesDirectory?: string;
  api?: GoogleDocsApi; // test seam
}>;

export type ResolveGoogleSinkResult =
  | Readonly<{ ok: true; sink: GoogleDocsNoteSink }>
  | Readonly<{ ok: false; message: string }>;

export function resolveGoogleDocsSink(
  notePath: string,
  environment: NodeJS.ProcessEnv,
  options?: ResolveGoogleSinkOptions,
): Promise<ResolveGoogleSinkResult>;
```

Overrides mirror `FileTokenProviderOptions`'s style so tests never touch real filesystem locations,
matching the `scratchPath()`/`writeJson()` temp-dir pattern already established in
`test/google-file-token-provider.test.ts`.

Flow: read credentials → if unreadable or `document_id` absent, return `{ok:false, message}` →
compute `captureId` → read-or-mint the capture state file as described in Decision 1 → construct
`new GoogleApiDocsClient(new FileTokenProvider({ credentialsPath }))` (unless `options.api` is
supplied) → construct and return `GoogleDocsNoteSink`.

**Required change from review — message wording must never name `shorthand-config`.** Core's
one-way dependency rule (`2026-08-19-google-oauth-boundary-design.md` lines 17-19: core must know
nothing about `shorthand-config`, not even its name) applies to this message exactly as it already
applies to `readCredentials`'s own messages. `src/google/file-token-provider.ts:64` sets the
precedent: `"No Google credentials at ${path}; connect your Google account, then retry."` — no app
name. The missing-`document_id` message must follow the same convention, e.g.: `"No Google Doc
selected; connect your Google account and choose a target document, then retry."`

### 4. CLI wiring — `--sink markdown|google`

New flag on both `capture` and `enhance`, default `markdown`, added to `KNOWN_FLAGS` and the usage
string. Invalid values rejected the same way `--tier` already is.

`createEnhanceRunner` becomes `async` and returns
`{ok:true, runner: EnhanceRunner} | {ok:false, message: string}` instead of constructing
`EnhanceRunner` unconditionally. When `--sink google`, it awaits `resolveGoogleDocsSink(note,
environment)` and only builds `EnhanceRunner` on success; when `--sink markdown` (or absent), it
builds `MarkdownNoteSink` exactly as today.

`runCapture`/`runEnhance` await the result. On `{ok:false}`, print `message` and return exit code 1.
For `capture`, this resolution happens before `client.start()` — a bad Google configuration fails
before the recording stream begins, not mid-meeting. This required no reordering of the existing
`bin/shorthand-notes.ts:154-263` control flow (SIGINT handling, the sidecar, `--fake-stream`):
sink resolution already sits ahead of all of it.

`--sink google` on `capture` without `--enhance` is accepted and silently inert, consistent with how
other enhance-only flags (e.g. `--tier`) already behave when `--enhance` is absent — no special-case
validation is added for this combination.

## Testing

- `addDocumentTab` against a fake `documents` resource, matching `test/google-docs-client.test.ts`'s
  style: success (title in, tabId out), and each `DocsApiError` mapping.
- `resolveGoogleDocsSink`, using the temp-dir pattern from `test/google-file-token-provider.test.ts`:
  - Mints a tab and writes the state file on first run.
  - Reuses the stored `tabId` when the state file's `documentId` matches current credentials.
  - Re-mints and overwrites the state file when `documentId` no longer matches (target changed).
  - A corrupt/unparseable state file resolves successfully with a freshly minted tab — `{ok:true}`,
    **not** an error case. (Corrected from an earlier draft of this design, which listed it
    alongside the two genuine error paths below; that was an internal contradiction the review
    caught — a disposable-cache miss is not the same class of failure as an unreadable credential.)
  - `{ok:false}` when credentials are unreadable.
  - `{ok:false}` when `document_id` is absent — asserting the message does not name
    `shorthand-config` or any consumer app.
  - `{ok:false}` when the `addDocumentTab` call itself fails (transport/auth) — the actual network
    operation in this flow, previously uncovered.
- `bin/shorthand-notes.ts` (`test/cli.test.ts`): `--sink` value validation; the missing-credentials
  error path surfaces the message and exit code 1; a fail-fast ordering test proving `capture` never
  starts the recording stream when Google sink resolution fails (e.g. via a marker the `--fake-stream`
  fixture would otherwise leave).

## Explicitly out of scope / deferred

- Cleanup of stale `captures/*.json` files.
- Cleanup of orphaned Google Docs tabs left behind by a `document_id` change (see Decision 1).
- `folder_id` is never read by any of this code. It is informational metadata for whichever app
  manages an app-created folder; core only ever needs `document_id`, which is already flow-agnostic
  between the Picker and app-created-folder target-selection flows — confirmed during design review,
  no code changes needed here or later when the app-folder flow ships.
- `docs/CONTRACT.md` line 29's `shorthand-core/google` export row should be updated to add
  `resolveGoogleDocsSink`, `ResolveGoogleSinkOptions`, and `ResolveGoogleSinkResult` alongside the
  existing entries, as part of this change — not deferred, but called out here so the implementation
  plan includes it rather than treating code changes as the whole task.

## Verification

1. `grep -rn "addDocumentTab" src/ test/` finds the new method, its implementation, and its tests —
   no longer zero hits.
2. `bun run typecheck` passes, including the two updated fakes in Decision 2.
3. `bun test` passes, including the new capture-sink and CLI cases above.
4. `shorthand-notes capture --note <note> --enhance --sink google` against a hand-written
   credentials file (per the handoff note's "testing unlock") produces a real tab in the target
   document, and re-running against the same note reuses it rather than creating a second one.
