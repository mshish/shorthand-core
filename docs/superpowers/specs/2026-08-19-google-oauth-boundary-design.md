# Core sheds the Google consent flow and becomes a pure credential reader

**Status: design spec, rewritten. This replaces an earlier draft at this same path whose central
decision — that `shorthand-config` would shell out to core's CLI to persist credentials — was found
incoherent on review and has been reversed by the human. Decisions marked "settled" were made by the
human and are recorded, not re-derived.**

**Not committed to git — written to disk only, at the user's request, until reviewed.**

**Scope of this document:** everything that happens *inside* `shorthand-core`, and the contract core
publishes for whoever writes its credentials file. The `shorthand-config` app — the Rust
reimplementation of the consent flow, its distribution, its signing — is a **separate document**,
`2026-08-19-shorthand-config-app-brief.md`, held here only until that repo is scaffolded.

The dependency direction is one-way and is the governing constraint on everything below, in the
human's words: **"config will be coupled to core but we don't want the reverse to be true."** Core
must know nothing about `shorthand-config` — not its name, not its Google client, not its install
location, not whether it exists.

---

## What this supersedes

| Document | What this spec changes |
| --- | --- |
| The prior draft at this path (2026-08-19, first version) | Its **"The write-only credentials command in core"** section is deleted outright, along with the `set-google-credentials` subcommand it proposed. Its claim that every moving item is an import-graph leaf was wrong for `container-doc.ts`. Its verification steps 1 and 3 were unrunnable as written. Its research notes on Tauri signing and the Handy fork move to the app brief. |
| `2026-08-18-google-docs-sink.md` | Its **"CLI bootstrap: `google-login`"** section, its Phase 1c addendum's `google-login --create`, and the paragraph in **"The `TokenProvider` port"** promising a keychain-backed second implementation. **Its L104–110 framing — `google-login` as "the standing answer to what does a self-hosted or non-paying user do, forever, without the installer" — is superseded outright. Obtaining a Google credential is `shorthand-config`'s job, full stop.** The sink, the renderer, the error mapping, the scope invariant and the concurrency design are untouched. |
| `2026-08-18-setup-config-app-brief.md` | Two of its "decisions already made" were wrong on the facts: credentials do not move to the OS keychain yet (deferred, route recorded, not rejected), and the Handy fork's signing/CI pipeline is not meaningfully reusable. |
| `2026-08-18-enhance-google-sink-handoff.md` | Answers its "real open question" in the direction of neither option it offered. `tabId` acquisition is confirmed as core's job and is confirmed as *not* this spec's job. |

---

## The boundary (settled)

> **Core owns everything that happens *after* a credential and a target already exist.**
> Runtime Docs and Drive API operations against an already-authorized identity are core's.
> Whatever *obtains* a credential or a target in the first place — interactive, one-time,
> UI-adjacent setup — is a consumer concern.

This is the same shape as `NoteSink` and `agentContext`: core is headless, and the moment a design
requires core to open a browser window, run a listener a human is expected to interact with, or
render a consent screen, the design has crossed out of core.

The prior draft added a rider: "it does not say core never writes files — persisting a credential it
was handed is not obtaining one, and stays." **That rider is withdrawn.** The reason is not the
principle; it is a file-ownership rule the prior draft did not apply:

> **One writer per file.** A file with two writers in two languages has an invariant that lives in
> neither of them.

Core reading a file it does not write is a contract. Core and `shorthand-config` both writing it is
a merge protocol, and a merge protocol is what `mergeCredentials` already is — a function that exists
solely to preserve a field its own caller can never set. Removing the second writer removes the
merge, and removing the merge removes a class of silent data loss. That is a deliberate
simplification, recorded here so nobody later "restores" `mergeCredentials` thinking it was lost by
accident.

Two consequences follow, and both are settled:

1. **There is no shell-out from `shorthand-config` to core, and no write-only credentials command in
   core.** The prior draft's `shorthand-notes set-google-credentials` does not get built. Two reasons,
   both recorded because the second is the one that makes it wrong in principle rather than merely
   heavy:
   - *Cost.* Invoking core's CLI to write a JSON file loads the whole CLI bundle. That bundle
     statically imports `@anthropic-ai/claude-agent-sdk`; the esbuild output is ~34 MB with the SDK
     externalized, and a `bun build --compile` binary that inlines it is **132 MB** (measured — see
     "The runtime prerequisite, answered"). That is an extraordinary amount of machinery to move
     three strings onto disk.
   - *Bootstrapping order.* It makes the installer depend on the thing it installs. `shorthand-config`
     would have to resolve, ship or fetch a working core before it could complete the very setup step
     whose purpose is to make core usable. That is backwards, and no amount of tuning the subprocess
     interface fixes it.
2. **`shorthand-config` writes the credentials file directly, in Rust, and core is a pure reader.**
   Core's job is to *define the contract* and to *enforce it executably* — see "The conformance
   fixture". Core does not care what satisfies the contract.

Applied to today's code, the line runs straight through `src/google/`: `oauth.ts` and
`container-doc.ts` are on the consumer side; `file-token-provider.ts` and everything under
`docs-sink.ts` are on core's side.

**This is a deletion, not a move.** The TypeScript in `oauth.ts` and `container-doc.ts` is a
**reference implementation** — verified working against real Google, interactively, including
`trigger_onepick=true` — and it is the source `shorthand-config`'s Rust port reads from. Once the
port works, the TypeScript is deleted from core. It does not live on in core as dead code "in case".

---

## What core sheds

**Whole files, deleted:**

- `src/google/oauth.ts` — `generatePkceChallenge`, `buildAuthorizationUrl`, `listenForRedirect`,
  `exchangeCode`. The interactive consent round-trip in its entirety.
- `src/google/container-doc.ts` — `ensureContainerDoc`, which creates the Drive folder, creates the
  container Doc, and reparents it. This is *obtaining a target*.

**From `bin/shorthand-notes.ts`:**

- `runGoogleLogin` (L485–557) and its helpers `describeContainerDocOutcome` and `openInBrowser`.
- The `google-login` dispatch arm (L91).
- The `google-login` line in `usage()` (inside the string at L39).
- The dispatch error string at **L92**: `"Expected capture, enhance, init-note, read-block, set-sections, or google-login."` — this names `google-login` and is asserted on by tests. The prior draft's breakage list omitted it.
- The `--client-id`, `--client-secret`, `--port` and `--create` entries in `KNOWN_FLAGS` (L52).

**From `src/google/file-token-provider.ts`:**

- `writeCredentials` and `mergeCredentials` — core stops writing this file at all.
- `FileTokenProviderOptions.clientId` / `.clientSecret` — these now come from the file (below).

**From `src/google.ts`:**

- L24–25, the `ensureContainerDoc` / `ContainerDocResult` re-exports.
- L21, the `writeCredentials` re-export.

**Tests deleted with their subjects:** `test/google-oauth.test.ts`, `test/google-container-doc.test.ts`,
and the `mergeCredentials` cases in `test/google-file-token-provider.test.ts` (which includes the
`tabId`-preservation test at L31 — the invariant it pins ceases to exist).

### Correction: the leaf claim was wrong for one of the two files

The prior draft said "every item below is a leaf with no importer anywhere under `src/`". Verified,
and it is **false for `container-doc.ts`**: `src/google.ts:24-25` re-exports `ensureContainerDoc` and
`ContainerDocResult`. `oauth.ts` genuinely is a leaf — nothing under `src/` imports it; only
`bin/shorthand-notes.ts:496` does, via dynamic `import()`.

This matters because it is exactly the difference between an internal deletion and a **breaking
change to the published surface**, which the prior draft's leaf framing concealed.

### The breakage list, in full — including the version bump

| Site | What breaks | Kind |
| --- | --- | --- |
| `src/google.ts:24-25` | Re-exports a deleted module. | Compile error. **Breaking API change** — `ensureContainerDoc` and `ContainerDocResult` leave `shorthand-core/google`. |
| `src/google.ts:21` | `writeCredentials` re-export removed. | **Breaking API change.** |
| `src/google/file-token-provider.ts` | `GoogleCredentials` retyped (fields renamed, `tabId` removed), `FileTokenProviderOptions` retyped (`clientId`/`clientSecret` gone). | **Breaking API changes** — both types are exported from `shorthand-core/google` (L22). |
| `bin/shorthand-notes.ts` L39, L91, L92, L52, L485–557 | Five edit sites, listed above. | Compile + behaviour. |
| `src/google/file-token-provider.ts:73` | User-facing string: *"run \`shorthand-notes google-login\` first."* Tells the user to run a command that will not exist. | **Compiles fine, fails silently as bad UX.** |
| `src/google/file-token-provider.ts:89` | User-facing string: *"Google revoked this credential; run google-login again"*. Same failure mode. | Same. |
| `src/google/file-token-provider.ts:34` | Doc comment describing `mergeCredentials` as merging "from a `google-login` run". | Stale comment; goes with the function. |
| `test/cli.test.ts:241-311` | Six tests. Two are not google-login tests in substance — see below. | Test breakage. |
| `test/google-file-token-provider.test.ts:31` | `mergeCredentials` `tabId`-preservation test. | Test deletion. |

The two `file-token-provider.ts` message strings are the ones most likely to survive the change by
accident, because nothing fails when they are wrong. They must be rewritten to point at whatever
obtains a credential without naming it — core cannot name `shorthand-config` (the one-way dependency
rule). Something of the shape *"No Google credentials at `<path>`; connect your Google account, then
retry"* keeps the path (which is genuinely useful and is core's own) without importing knowledge of
its consumer.

**Version bump: `0.7.0` → `0.8.0`.** Per `AGENTS.md` L59-60, "minor is the breaking slot. Removing or
retyping an exported symbol is a minor bump, not a patch." Four exported symbols are removed or
retyped. Per `AGENTS.md` L99-101, the commit gets a `!` and a `BREAKING CHANGE:` footer naming every
one of them.

**The downstream pin matters.** `obsidian-shorthand` consumes core as
`"shorthand-core": "github:mshish/shorthand-core#<tag>"` — a pinned tag (`AGENTS.md` L37-46), so it is
insulated until someone bumps the pin. Verified: nothing in the plugin can be reached from here, but
the ordering rule in `AGENTS.md` applies — land, push, tag, and the pin bump is the first step of any
plugin work that follows. The removed symbols are all under `shorthand-core/google`, which a Markdown
plugin has no reason to import, so the practical breakage risk is low. That is a reason to expect a
clean bump, not a reason to skip the footer.

**Zero dependencies can be dropped from `package.json`.** Verified: `google-auth-library` is still
used by the token provider, `googleapis` by `GoogleApiDocsClient`, `marked` by `renderer.ts`. The
change shrinks core's surface, not its dependency tree.

### The six `google-login` tests: two of them are not about `google-login`

`test/cli.test.ts:241-311`. Four are ordinary argument-validation tests for a command that ceases to
exist; they are deleted. Two are not:

- **L269-290**, *"run() strips GOOGLE_OAUTH_CLIENT_ID/SECRET from any env it's given"*. Its own
  comment records that it exists because every other test in the file held the property only by
  caller discipline, and that a real incident — a test spawning a browser with real credentials —
  prompted it.
- **L292-311**, *"--no-env-file prevents .env file leaks to subprocesses"*. Same family: it proves the
  spawn helper does not inherit a developer's real `.env` into a subprocess.

Both are **harness-leak regression tests wearing a `google-login` costume**. `google-login` is
merely the command they use as a fast-failing probe. Deleting all six orphans the
`stripGoogleOAuthEnv` / `withoutGoogleOAuthEnv` helpers (L319+) and removes the only proof that
`run()`'s unconditional strip still happens.

**Decision: keep and retarget both.** They move to a surviving command and stop asserting on
`google-login`'s error text.

The retarget is not free and the difficulty must be stated rather than waved at: both tests work
because `google-login` *fails fast on a missing credential*, which gives a cheap, deterministic
signal that the env did not carry credentials through. No surviving command has that shape. The
honest replacement asserts the property **structurally rather than behaviourally**: call
`stripGoogleOAuthEnv` and `run()`'s env-construction directly and assert the two keys are absent from
what would be handed to `spawn`, using any cheap command (`init-note` in a scratch dir) as the
subject. That is a weaker test than the one being replaced — it proves the strip happens, not that a
browser cannot open — and the weakening should be recorded in the test's own comment, since the
existing comment's story about the incident is the reason the test is load-bearing at all.

Retiring them instead would also be defensible, but only with the reason written down, and the reason
would have to be "the incident this guards against is no longer reachable" — which is **not true**:
`run()` is still there, `process.env` is still its default, and a future test can still spawn with
real credentials. So: keep.

---

## What core keeps, and what core gains

**Keeps:**

- `TokenProvider` and its error types (`src/auth/token-provider.ts`), unchanged. This is the port; it
  is a one-method interface and nothing here touches it.
- `FileTokenProvider`, `credentialsPath`, `readCredentials` — retyped, not removed.
- `GoogleDocsNoteSink` (`docs-sink.ts`), `GoogleApiDocsClient` (`docs-client.ts`), `renderer.ts`,
  `requests.ts`, and `GOOGLE_DOCS_SCOPE`.

The fact that makes this clean was verified directly: **`file-token-provider.ts` does not import
`oauth.ts`.** Its `defaultRefresher` builds a `google-auth-library` `OAuth2Client` and calls
`getAccessToken()`, exchanging a refresh token for an access token. That is post-consent runtime work
against an identity that already granted access, and it needs nothing from the consent module.

**Gains:**

- Reading `client_id` and `client_secret` from the credentials file rather than from constructor
  arguments (below).
- **Runtime validation of the credentials file.** Today `readCredentials`
  (`file-token-provider.ts:24-31`) does a bare `JSON.parse` and a type assertion, with no validation.
  That was tolerable while core wrote the file itself. It is not tolerable when the writer is a
  different program in a different language: a malformed or partial file currently throws out of
  `getAccessToken()` instead of returning a `TokenResult` error, which means a bad file crashes a
  capture instead of reporting "not authorized". Core gains explicit validation mapping every
  malformed shape to `tokenError("not-authorized", …)` with a message naming the missing field.
- A published **credentials-file conformance fixture** (below).

---

## The credentials file, as core now defines it

### Alignment with Google's Application Default Credentials (`authorized_user`)

The standard-path answer, per the human's global rule, is Google's own format. `gcloud auth
application-default login` writes an `authorized_user` JSON file, and `google-auth-library` — already
core's dependency, pinned at `10.5.0` — loads it natively.

**The schema was verified against the actual installed source, not from memory.** Read:

- `node_modules/google-auth-library/build/src/auth/refreshclient.js` — `USER_REFRESH_ACCOUNT_TYPE = 'authorized_user'` (L19); `UserRefreshClient.prototype.fromJSON` (L94–116).
- `node_modules/google-auth-library/build/src/auth/googleauth.js` — `GoogleAuth.fromJSON` (L476–510), which dispatches on `json.type` and hands the whole object to `UserRefreshClient`.
- `node_modules/google-auth-library/build/src/auth/credentials.d.ts` — the `JWTInput` interface (L53–64), which is the parameter type.

**What `fromJSON` actually does, verbatim from the source:**

| Field | Behaviour |
| --- | --- |
| `type` | **Required.** Must equal `"authorized_user"` exactly, or it throws `The incoming JSON object does not have the "authorized_user" type`. `GoogleAuth.fromJSON` also dispatches on this value; anything else routes to the JWT/service-account path. |
| `client_id` | **Required.** Missing → `does not contain a client_id field`. |
| `client_secret` | **Required.** Missing → `does not contain a client_secret field`. |
| `refresh_token` | **Required.** Missing → `does not contain a refresh_token field`. Also assigned to `this.credentials.refresh_token`. |
| `quota_project_id` | Optional, read and stored. |
| `universe_domain` | Optional, read; falls back to the client's default. |

`JWTInput` additionally declares `client_email`, `private_key`, `private_key_id`, `project_id` — those
belong to the service-account shape and are not read on this path.

**Extra fields are tolerated.** Verified by reading, not inferred: `UserRefreshClient.fromJSON` reads
six named properties off the object and does nothing else with it. There is no key allow-list, no
schema validation, no `Object.keys` iteration, and no throw on unknown properties anywhere in
`GoogleAuth.fromJSON` → `UserRefreshClient.fromJSON`. A file carrying additional top-level keys loads
exactly as one without them.

That verification is what makes the next decision viable.

### Decision: one superset file, not a sibling

ADC has no slot for `document_id` or `folder_id`. Two options existed: a superset of the ADC shape in
one file, or a strict-ADC file plus a sibling file holding our fields.

**Decision: superset — one file.** Reasons, in order of weight:

1. **A sibling file re-creates the problem this whole redesign removes.** Two files with the same
   owner, the same lifetime and the same write moment means two writes, which means a torn state
   between them: credential present, target absent, or the reverse. The single-writer-per-file rule
   is worth exactly nothing if the writer has to keep two files consistent.
2. **The extra keys are verified harmless.** Google's own loader ignores them (above). If they were
   not — if `fromJSON` rejected unknown keys — the superset would not be viable and this decision
   would have to flip. It was checked rather than assumed for that reason.
3. **`document_id` is meaningless without the credential and vice versa.** They are not two concerns
   that happen to share a directory; they are one connection.
4. **One file is one atomic write.** The writer's whole persistence step is a single
   write-then-rename, with no ordering to get right and no half-written state to reason about.

The honest cost: the file is a superset, so it is not a byte-for-byte ADC artifact. What survives is
the property that matters — any Google tooling that reads `authorized_user` reads ours unchanged,
because the loader ignores the extra keys.

### The shape

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

- `type`, `client_id`, `client_secret`, `refresh_token` — required, ADC-standard, names fixed by
  Google.
- `document_id` — required by core when constructing the sink. Ours.
- `folder_id` — optional. Ours. Present when the target doc lives in an app-created folder.
- **No `tab_id`.** See "Where per-capture `tabId` state lives".

**Field naming is `snake_case` throughout, including our two fields.** This renames today's
`documentId`/`folderId`. A mixed-case file — Google's four in snake, ours in camel — would be a
permanent small ugliness and a permanent small source of typos, for no gain. The rename is free
*right now* and will never be free again, because **every existing `google-credentials.json` is
already dead** for an unrelated reason (next section). Taking the rename at the same moment costs
nothing; deferring it means paying a migration later.

### Path, permissions, atomicity

**Path:** `join(shorthandConfigDirectory(env), "google-credentials.json")` — unchanged, and core's
`credentialsPath()` (`file-token-provider.ts:14-16`) remains the definition. `shorthandConfigDirectory`
(`src/config.ts:50-59`) resolves:

| Platform | Directory |
| --- | --- |
| `win32` | `%APPDATA%\Shorthand`, falling back to `<home>\AppData\Roaming\Shorthand` |
| `darwin` | `~/Library/Application Support/Shorthand` |
| other | `$XDG_CONFIG_HOME/shorthand`, falling back to `~/.config/shorthand` |

`<home>` is `USERPROFILE ?? HOME ?? os.homedir()`.

**Serialization:** pretty-printed JSON, 2-space indent, trailing newline. The formatting is pinned so
the conformance fixture can compare against golden bytes rather than against a parsed object — a
byte-level assertion catches a writer that is *nearly* right, which a structural one does not. It also
keeps the file legible when a developer opens it to diagnose a broken credential.

**Permissions:** mode `0600` on non-Windows. On Windows the file inherits `%APPDATA%`'s ACL. That
inheritance is a known weakness — it was a known weakness before this change and is not fixed by it,
and whoever fixes it should first confirm what `%APPDATA%` actually grants rather than assuming.
Recorded in "Open questions".

**Writes must be atomic — write to a temp file in the same directory, then rename over the target.**
This is a hard requirement of the contract now, where before it was advice. The reason changed: core
no longer controls the writer, `readCredentials` runs during a live capture, and a torn file read
mid-write is indistinguishable from a corrupt one. Same-directory rename is required because
cross-filesystem rename is not atomic.

### `client_id` and `client_secret` move INTO the file — reversing a deliberate exclusion

Today these are constructor arguments to `FileTokenProvider` (`file-token-provider.ts:53-59`),
deliberately kept out of the file. That exclusion is reversed. The reversal is the direct consequence
of the one-way dependency rule, and the alternatives were considered and rejected on the record:

| Option | Why not |
| --- | --- |
| Compiled constants in core | Embeds `shorthand-config`'s Google identity in core. That is the dependency running the wrong way: core would ship a credential belonging to an app it must not know about, and the app's OAuth client could then only be rotated by releasing a new core. |
| Environment variables injected by whoever launches core | Makes core's correctness a function of *how it was launched*. A capture started from a terminal, from the Tauri app, from a scheduler, and from a test would each have different auth behaviour with identical code and identical on-disk state. That is the failure mode that produces "works on my machine" bug reports nobody can reproduce. |
| **Read from the credentials file** (chosen) | Core defines a contract; *something* satisfies it. Core does not know or care what. |

There is a second, independent reason, and it is the one that ages best: **a refresh token is only
meaningful paired with the client that issued it.** Storing the token in one place and its client in
another is storing half a credential in each. The ADC format encodes exactly this — Google puts all
three in one file — which is a good sign the standard path already worked this out.

**Consequence, stated plainly and accepted:** `shorthand-config` registers its own new Google Cloud
OAuth client. A refresh token is bound to the OAuth client that issued it. Therefore **every existing
`google-credentials.json` becomes unusable and every existing user must re-consent.** There is no
migration and none is wanted — the population is one developer's test files. This is known and
accepted, not a discovered risk.

### What core does with the file

`FileTokenProvider` reads the file, checks `type === "authorized_user"` and the three required ADC
fields, and hands the parsed object to `google-auth-library`'s own loader —
`UserRefreshClient.fromJSON(json)` — rather than reconstructing an `OAuth2Client` by hand. That is the
standard path, and it deletes core's own field-plumbing.

The token-caching fix recorded in `2026-08-18-google-docs-sink.md` ("Follow-up fix: token caching was
accidentally defeated") **survives this change**, verified by reading:
`refreshclient.js` shows `UserRefreshClient extends OAuth2Client` and overrides only
`refreshTokenNoCache` and `fetchIdToken`. `getAccessToken()` is inherited unmodified, so the caching
analysis already recorded in the doc comment at `file-token-provider.ts:98-108` — that
`getAccessTokenAsync()` only refreshes when `!credentials.access_token || isTokenExpiring()` — applies
unchanged. The requirement stands: hold **one** client instance across calls. Constructing a
`UserRefreshClient` per `getAccessToken()` call would re-break the cache in exactly the way that was
already fixed once.

### `mergeCredentials` is deleted, deliberately

It exists (`file-token-provider.ts:33-51`) for one reason, stated in its own doc comment: to preserve
a `tabId` across a whole-file overwrite by a caller that can never set one. With `tabId` out of the
file and only one writer left, there is nothing to merge. The overwrite is the correct semantic.

This also retires a **known deferred bug** recorded in the prior draft: a picker-flow re-login left a
stale `folder_id` from a previous `--create` run, because the merge fell back to the existing value
when the update omitted one. With no merge, an omitted field is an absent field. The bug is not fixed
so much as made unrepresentable, which is better.

---

## Where per-capture `tabId` state lives

`tabId` is **not a credential.** It identifies one meeting's tab inside a document. It is minted by
core at meeting start via the Docs API's `addDocumentTab`, and it changes every meeting. Nothing about
it is secret, nothing about it is durable, and nothing about it belongs to the entity that performs
consent.

There is a second reason it was in the wrong file, which is structural rather than conceptual and
which the prior draft missed: **`GoogleCredentials.tabId` is a single optional string in a single
global file** (`file-token-provider.ts:7-12`). Two concurrent captures could not both be represented.
The field was not merely misplaced; it could not have worked once more than one meeting ran at a time.

**Decision: per-capture sink state is its own file, written and owned by core, at
`join(shorthandConfigDirectory(env), "captures", "<captureId>.json")`.**

- **Keyed by capture**, so concurrent meetings do not collide — the defect the credentials-file slot
  had structurally.
- **In `shorthandConfigDirectory`**, reusing the platform resolution `src/config.ts:50-59` already
  establishes rather than inventing a second convention for where Shorthand state lives (the same
  reasoning that doc comment already records for the credentials file).
- **Not in the meeting note or its frontmatter.** That would be Markdown-coupled, and a Google Docs
  capture may have no Markdown note at all.
- **Not in the credentials file**, which is the whole point.

The result is the one-writer-per-file rule holding across both files: `shorthand-config` writes
credentials and never reads or writes capture state; core writes capture state and never writes
credentials.

**Two things this document deliberately does not decide, because they belong to the enhance/capture
wiring spec:**

1. **The minting itself.** Verified: `grep -rn "addDocumentTab"` across `src/`, `bin/` and `test/`
   returns **zero hits**. Nothing calls it. When and how `addDocumentTab` runs, what titles tabs get,
   and how a capture id is derived are all that spec's decisions.
2. **Whether the state needs to be persisted at all, versus held in memory for the capture's
   lifetime.** A capture that never restarts never needs a file; a capture that crashes mid-meeting
   and resumes does, or it creates a second tab. That trade — and the file's schema, lifecycle and
   cleanup — is the wiring spec's to make. What is settled *here* is only that it does not go in the
   credentials file and that core owns it wherever it lands.

The plain consequence, unchanged from the prior draft and worth restating: **`GoogleDocsNoteSink` is
currently not constructible from any persisted state.** The whole path exists and is tested against
fakes; nothing can reach it from a real credential. That gap is not closed by this spec.

---

## The conformance fixture

Prose contracts drift. Core already knows this and already solved it once, for external sink
implementers: `src/testing/sink-conformance.ts` ships `NOTE_SINK_CONFORMANCE_SCENARIOS` and
`describeNoteSinkConformance` as **shipped API, not tests** — no test-runner import, no assertion
library, every scenario a plain async function that throws on failure (`CONTRACT.md` §5, and the
module's own header comment L4-18). The credentials file gets the same treatment, modelled on that
mechanism faithfully.

### Shape, following the sink precedent exactly

```ts
export type CredentialsWriterHarness = Readonly<{
  /** Write these credentials wherever the implementation writes them, and report the path. */
  write(credentials: CredentialsFixture): Promise<string>;
  dispose?(): Promise<void>;
}>;

export type CredentialsConformanceScenario = Readonly<{
  name: string;
  run(createHarness: () => Promise<CredentialsWriterHarness>): Promise<void>;
}>;

export const GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS: readonly CredentialsConformanceScenario[];

export function describeGoogleCredentialsConformance(
  primitives: ConformanceTestPrimitives,   // the SAME type the sink suite already exports
  name: string,
  createHarness: () => Promise<CredentialsWriterHarness>,
): void;
```

`ConformanceTestPrimitives` is reused rather than redefined (`sink-conformance.ts:307-313`) — one
runner-adapter shape for the whole `shorthand-core/testing` surface.

Additionally, and unlike the sink suite, core ships **`GOOGLE_CREDENTIALS_FIXTURES`: canonical
credential objects paired with their exact expected file bytes.** The sink suite does not need this
because sink implementers are all TypeScript. The credentials writer is Rust, so a language-neutral
golden artifact is worth having on its own: a Rust unit test can assert against the bytes with no
JavaScript involved at all.

### The cross-language seam is the harness, deliberately

The scenarios stay in TypeScript, in core, in one place. The language boundary sits at
`write()` — `shorthand-config`'s harness is a few lines that shell out to a test-only subcommand of
its own binary, which writes the file. That is the same architectural choice `SinkHarness` already
makes: the harness is where the transport-specific (here, language-specific) part goes, and the
scenarios never know about it.

**The honest cost, stated because it is a real dependency:** running the suite means
`shorthand-config`'s CI needs Bun (or Node plus a TS loader) to execute core's raw-`.ts` export map.
That is a **CI-only** dependency — it does not touch the shipped app, its runtime, or its installer.
Accepting a build-time toolchain to keep the contract executable is a good trade; accepting one at
runtime would not have been, and that distinction is exactly what killed the shell-out design.

### Scenarios the fixture must contain

Writer-side (run by `shorthand-config`'s CI):

1. **Path.** The reported write path equals core's own `credentialsPath()` for the platform. This is
   the scenario that prevents `shorthand-config` from re-deriving the platform directory and drifting.
2. **Core can read it.** `readCredentials` on the written file returns every field the fixture supplied.
3. **`type` is exactly `"authorized_user"`.**
4. **Google's own loader accepts it.** `UserRefreshClient.fromJSON` on the parsed file does not throw.
   This is the scenario that actually pins ADC alignment — everything else could pass with a
   home-grown format that merely looks similar.
5. **Permissions.** Mode `0600` on non-Windows. Skipped, visibly, on Windows — declared like the sink
   suite's `support` flags rather than probed, so an unrun scenario shows as `todo` rather than
   silently absent (`CONTRACT.md` §5.3's rule).
6. **Overwrite is wholesale.** Write a file containing `folder_id`, then write one without it, and
   assert `folder_id` is **gone**. This is the scenario that pins the `mergeCredentials` deletion: a
   writer that helpfully preserves fields has reintroduced the merge and must fail.
7. **No debris.** After a write, the directory contains the credentials file and no temp file — the
   observable half of the write-then-rename requirement.
8. **Formatting.** The bytes match the golden fixture: 2-space indent, trailing newline.

Reader-side (core's own new tests, not part of the exported fixture):

9. Every malformed shape returns `tokenError("not-authorized", …)` naming the missing field, rather
   than throwing: absent file, non-JSON bytes, wrong `type`, and each of the four required fields
   missing in turn.
10. **Unknown top-level keys are ignored, not rejected.** Forward compatibility: a newer
    `shorthand-config` writing a field an older core does not know must not break the older core.
11. A file with `client_id`/`client_secret`/`refresh_token` but no `document_id` is reported as a
    **distinct** error from a missing credential — the grant is fine, the target is missing. This is a
    reachable state: consent succeeds, then target selection fails or is cancelled, and the two halves
    need different messages because they need different user actions.

### Entry point

`shorthand-core/testing` currently resolves to a single module (`package.json` `exports`:
`"./testing": "./src/testing/sink-conformance.ts"`). Adding a second testing module means either a
new subpath or turning `./testing` into a barrel. **Recommend the barrel** (`src/testing/index.ts`,
explicit named re-exports per `AGENTS.md` L88-91 — `export *` is banned): `CONTRACT.md` §1 describes
`shorthand-core/testing` as "the executable contract", singular, and splitting subpaths widens the
`exports` map for no reader benefit. This is an **additive** change to that entry point, not a
breaking one.

`docs/CONTRACT.md` §1's table row for `shorthand-core/testing` must be updated to list the new
exports.

---

## The scope guard

`test/google-scope-guard.test.ts` walks `src/` and `bin/` for files ending `.ts`, matches
`/googleapis\.com\/auth\/[\w.]+/g`, and fails on any match that is not `drive.file`. Exactly one match
exists today: `GOOGLE_DOCS_SCOPE` in `src/google/docs-sink.ts:7`.

**Verified weakness, unchanged: the guard also passes when there are zero matches.** It cannot
distinguish "correctly scoped" from "the scope code left the building."

**Correction to the prior draft's framing.** It said "the guard's meaning in core is gutted" after the
move. That is overstated. `GOOGLE_DOCS_SCOPE` stays in `docs-sink.ts` — the sink is what the scope
describes and what fails at runtime if the grant is wrong — so core still has one match and the guard
still fails on a second scope introduced anywhere in `src/` or `bin/`. What is genuinely lost is
narrower and should be stated as exactly that: **core no longer *requests* the scope.** Core declares
a constant it uses to talk to Google; the authorization URL that actually asks the user for it is
built elsewhere. So core's guard now protects against a scope constant creeping into core, and no
longer protects against the request widening.

Therefore:

1. **Add a positive assertion to core's guard**: at least one `drive.file` match must exist, anchored
   on `src/google/docs-sink.ts`. A guard that passes on an empty result set is not a guard.
2. **Copy the guard to `shorthand-config`** — copy, not move. Both repositories run it.
3. **The copy must not be literal.** `shorthand-config`'s consent code is **Rust under `src-tauri/`**.
   A literal copy walks a `src/` frontend directory for `.ts` files, finds zero matches, and passes —
   the exact zero-match weakness, now guaranteed rather than merely possible. The copy must walk
   `src-tauri/` for `.rs` (and `src/` for `.ts`/`.tsx`, since the frontend can also embed a URL), and
   its positive assertion must be anchored on **the file that builds the authorization URL**, not on
   any file that merely mentions a scope.
4. **`shorthand-config` duplicates the scope string rather than importing it.** Importing it would
   mean a Rust app taking a build dependency on core's raw-TypeScript export map for one string
   literal. The duplication is safe *because* the copied guard turns an unnoticed divergence into a
   test failure in both repositories. Record that reason next to the duplicated constant, not merely
   the fact of duplication.

**The cost of scope creep, with provenance corrected.** Anything beyond `drive.file` moves the product
into Google's sensitive or restricted OAuth review tier, with mandatory verification. Two specifics
the prior draft asserted flatly need marking:

- *"A 100-new-user cap until verified."* — **UNVERIFIED, and the prior draft's framing is probably
  wrong.** The cap is understood to apply to apps in testing/unverified publishing status generally,
  not as a function of scope tier. The scope tier drives whether verification is *required*; the cap
  is a property of being unverified. Confirm against Google's own OAuth verification documentation
  before this is repeated anywhere user-facing.
- *"An annual third-party CASA assessment for restricted scopes."* — **UNVERIFIED** in this pass;
  sourced from Google's developer documentation in an earlier research session but not re-read here.

`drive.file` is classified non-sensitive by Google (sourced from Google's own guidance; recorded in
`2026-08-18-google-docs-sink.md`), which is what avoids all of it. The guard is cheap and the failure
is expensive, which is the whole argument for keeping it on both sides.

---

## Sequencing: the deletion lands now

`shorthand-config` does not exist. Deleting `google-login` leaves no shipping artifact able to obtain
a credential until the Rust port works. That window is real and must be argued, not skipped.

**Decision: the deletion lands now, before the port exists.**

Three reasons, strongest first:

1. **A credential obtained today buys nothing.** `addDocumentTab` has zero call sites, so
   `GoogleDocsNoteSink` is not constructible from persisted state, and `createEnhanceRunner`
   hardcodes `MarkdownNoteSink` (recorded in the handoff note at `bin/shorthand-notes.ts:330`).
   `google-login` currently writes a file that nothing in the shipping product reads — its own success
   message says so: *"Google Docs sink support is not yet wired into `shorthand-notes enhance`."* The
   window in which nothing can obtain a credential overlaps almost exactly with the window in which
   having one is useless.
2. **Keeping it means maintaining two consent implementations against two different Google clients.**
   `shorthand-config` registers its own OAuth client, which invalidates every token `google-login` has
   ever produced. Keeping `google-login` alive preserves a path to a credential that is dead on
   arrival the moment the app ships — and doubles the surface the scope guard has to cover in the
   meantime.
3. **Core's reader work needs the deletion.** Reading `client_id`/`client_secret` from the file,
   renaming the fields, dropping `tabId`, deleting `mergeCredentials` and adding validation are all
   the same change. Doing them while `google-login` still writes the old shape means writing a
   migration for a format with one user, and keeping two writers alive across the transition — the
   exact thing the one-writer rule forbids.

**The honest cost:** if the Rust port stalls, there is a period during which nothing obtains a
credential. Reason 1 is what makes that acceptable rather than merely tolerable — the window overlaps
almost exactly with the window in which a credential does nothing.

**One thing this deliberately does not do: replace `google-login` with anything.**
`2026-08-18-google-docs-sink.md` L104-110 framed that subcommand as "the standing answer to what does
a self-hosted or non-paying user do, forever, without the installer." **That framing is superseded.
Obtaining a Google credential is `shorthand-config`'s job, full stop**, and no fallback path is
designed here or elsewhere.

---

## The runtime prerequisite, answered

The prior draft claimed core's CLI "runs on stock Node 20+" as an advantage. The reviewer's objection
was correct: nobody in the non-technical target audience has Node 20, so "needs a runtime we do not
install" was a cost dressed as a benefit. With the shell-out gone this matters less for consent, but
core still has to *run* somehow.

**This is no longer an open question on Windows. It was run.**

> **Verified empirically on Windows 11, Bun 1.3.14, 2026-08-19, against `D:\tools\shorthand-core` at
> branch `main`.** Command: `bun build bin/shorthand-notes.ts --compile --outfile <tmp>/shorthand-notes-test.exe`.
> **macOS and Linux were not tested — no Mac was available and no Linux was exercised. Bun's
> cross-compilation targets exist but were not run. Treat non-Windows as UNVERIFIED.**

Observed, not inferred:

- **It compiles.** `bundle 1279 modules` in ~624 ms; `compile` in ~968 ms.
- **It bundled `@anthropic-ai/claude-agent-sdk`** — the package core's esbuild step deliberately
  externalizes. No `--external` was passed to `bun build`; everything went in.
- **Binary size: 132,004,352 bytes (~132 MB)**, standalone. No `node_modules` alongside it, no Node
  runtime required.
- **Command dispatch works.** An unknown command produced the correct usage error and exit code 2.
- **Real filesystem work works.** `init-note` produced a note with correct YAML frontmatter
  (`shorthand-capture`, `shorthand-transcript`), the `<!-- shorthand:notes -->` and
  `<!-- shorthand:ai:start/end -->` markers and the three default headings; `read-block` parsed it
  back and returned correct JSON with a sha256.
- **The Claude Agent SDK survives compilation and functions.** A full `enhance --dry-run` ran end to
  end from the compiled binary: it started an agent attempt ("Enhancement attempt 1 started (link)"),
  completed a live agent session against the machine's existing `claude` login, and emitted real
  AI-generated sections derived from the transcript. This was the single biggest risk —
  `@anthropic-ai/claude-agent-sdk-win32-x64` is a platform-specific native package, and native modules
  are what typically fails to survive bundling. It did not fail.

**Not exercised:** the Google credential path, because no CLI command constructs `FileTokenProvider`
today — only tests do. So nothing here says the credentials file works from a compiled binary; it says
the binary works.

**What this settles and what it does not:**

- The runtime-prerequisite gap largely closes. A compiled core needs no runtime at all — on Windows,
  demonstrated.
- The **132 MB** is a real number, not a footnote. It bears on bundling into a Tauri app and on any
  download-and-replace component flow, and it is the sharpest possible version of the argument against
  the shell-out design: invoking that to write three strings to a file was never proportionate.
- The macOS keychain precondition moves from *unknown* to *demonstrated on one platform and untested
  on the one that needs it* — see the next section.

---

## OS keychain storage: deferred, not foreclosed, and now with a concrete route

OS keychain storage is wanted **in the not too distant future**. This section records what blocks it
today, why the obvious workaround is worse than a file, and what has to become true. Nothing here says
the keychain is architecturally wrong. It says core does not yet have the identity the keychain checks
— and that the Rust rewrite plus the compile result have made that identity materially closer.

> **UNVERIFIED — read first.** No macOS testing was performed. Every macOS claim below derives from
> Apple's documentation, which is unambiguous about the access model, but the actual prompt text, how
> often a prompt reappears, and the behaviour of a `keyring-rs`-written item read from another process
> were **not observed**. Verify on real hardware before building against this.

### The precise blocker

Not "the macOS keychain is unusable." The **reader** has no application identity macOS recognises.
macOS gates keychain access on identity in both of its keychains:

- **Legacy / login keychain.** Items carry an ACL; Apple documents that the default ACL trusts only
  the creating application, so another caller triggers a password dialog. `keyring-rs` defaults here.
- **Data-protection keychain**, which Apple recommends via `kSecUseDataProtectionKeychain`. ACLs do not
  apply; **access groups** do — a team ID plus a bundle ID, enforced by a code-signing entitlement. A
  process without a matching entitlement gets `errSecItemNotFound`: a silent miss indistinguishable
  from "no such item."

Same gap, a nagging dialog on one keychain and a silent miss on the other.

### Why the documented workaround is rejected

Apple documents widening an item's ACL via `SecAccessCreate` with a trusted-application list built by
`SecTrustedApplicationCreateFromPath`. Two reasons not to, and both are worth keeping because they
fail differently:

1. **Trust binds to the binary's code signature, not its path.** Every interpreter upgrade invalidates
   the entry and the prompts return, on a cadence we do not control, with a password dialog appearing
   to a non-technical user mid-meeting.
2. **It would grant access to everything that interpreter runs.** Trusting an interpreter trusts every
   script it executes — strictly worse than a `0600` file, which at least confines access to the user
   account rather than to an interpreter anyone can invoke.

The first ages into an annoyance. The second is what makes it unacceptable in principle.

### The route, now concrete

Apple documents sharing keychain items among applications signed by the **same team**. That is exactly
our shape: a Tauri app writes, a companion executable reads. Three things must be true:

1. **Core ships as a compiled, code-signed executable rather than a script handed to a generic
   runtime.** *This was the unknown, and it is now partly answered:* `bun build --compile` produces a
   working 132 MB standalone binary on Windows, Agent SDK and all (previous section). The macOS
   equivalent is **untested** — Bun documents cross-compilation targets, but none were run. So the
   precondition is **demonstrated feasible on one platform, untested on the platform that needs it**,
   rather than unknown in both directions as the prior draft had it.
2. **It is signed with the same Apple team as `shorthand-config`.** No new cost: the $99/yr Apple
   Developer Program and a Developer ID certificate are already required for macOS distribution
   regardless, because unsigned macOS apps report "is broken and cannot be started."
3. **Both carry a matching `keychain-access-groups` entitlement and both use the data-protection
   keychain** (`kSecUseDataProtectionKeychain`). The legacy keychain's ACL model is the one to avoid.

**The Rust rewrite makes this easier, not harder.** `shorthand-config` is already a signed Rust
binary, so the *writer* side of a keychain implementation is free — the Rust `keyring` crate in an
app that is being signed anyway. Only core's side needs the compiled-and-signed work, and item 1 just
became a smaller unknown. The prior draft treated the whole thing as blocked on a single unanswered
question; half of that question now has an answer.

### Why the file is right today, and what deferring actually costs

The house rule is to record the actual reason. **The file is correct for as long as core is a script
executed by a generic runtime** — not because files are good, but because the process reading the
credential is a shared interpreter that macOS cannot distinguish from any other use of that
interpreter. Change what core ships as and the constraint goes away.

**On Windows**, Credential Manager is user-scoped with no application identity in its model at all, so
what a keychain buys there is DPAPI encryption at rest and nothing else — no inter-application
boundary exists to gain.

> **Provenance of the Windows empirical result — insufficient, recorded as such.** The prior draft
> claimed "a credential written by `C:\Windows\System32\cmdkey.exe` was read back by an unsigned Bun
> process with no prompt." The **method was not recorded**: which read API was used, whether the
> credential was generic or domain, and what `TargetName` it carried. Without those, the result is not
> reproducible and must be re-run before anything is built on it. The *documented* property — that
> Credential Manager has no application identity in its model — is what the design leans on, and that
> does not depend on the experiment.

**Precedent for the file:** `gcloud auth application-default login` stores a user OAuth refresh token
as plaintext JSON in the per-user config directory on every platform. This is **precedent for the
deferral, not a permanent argument against keychains.** Google made a different trade for a developer
tool than we will eventually make for a consumer product; citing it as though it settles the question
forever would be misreading it.

**Standard-path note.** The conventional answer for desktop secret storage *is* the OS keychain, and
this is a deliberate, time-limited deviation. What conflicts: the keychain's security value on macOS
comes from application identity, and core has none while it is a script run by a shared interpreter.
What the deviation costs: the refresh token sits in a `0600` file readable by anything running as that
user, with no encryption at rest on macOS or Linux. Accepted for v1.

### Why the port survives the switch, and what migration actually involves

`TokenProvider` is one method:

```ts
getAccessToken(): Promise<TokenResult>
```

Adding a `KeychainTokenProvider` alongside `FileTokenProvider` is **purely additive** — no change to
the port, no breaking change, no consumer affected, since the sink only ever calls `getAccessToken()`.

**But "migration is a one-time data concern, not a design one" was wrong**, and correcting it matters
because these questions have to be answered before anything is built, not after:

- **Which provider wins when both a file and a keychain item exist?** A precedence rule is a design
  decision with a security consequence — file-wins makes the keychain decorative; keychain-wins makes
  a stale file a confusing no-op.
- **Is the file deleted once the credential is in the keychain?** Deleting it is the only thing that
  actually removes the plaintext copy, and it is also irreversible if the keychain read then fails on
  a machine where the entitlement is wrong.
- **What happens when exactly one is populated?** Keychain-only on a machine where core cannot read it
  is indistinguishable from "no credential" (that `errSecItemNotFound` silent miss again) — so the
  fallback behaviour determines whether the user sees "connect your account" or a real error.
- **Does the writer or the reader own the migration?** With one-writer-per-file now a rule, only
  `shorthand-config` can move a credential *into* a keychain — which means the migration is a
  `shorthand-config` feature, not a core one.

None of these is hard. All of them are design, and none is answered here.

**Windows is unblocked today** — no application identity in the model means an unsigned reader is not
the obstacle it is on macOS. Noting the asymmetry rather than recommending it: a Windows-only keychain
path means two credential paths to maintain and test, for a platform where the gain is encryption at
rest and nothing more. Worth knowing it is available; not obviously worth taking before macOS can
follow.

---

## Documentation drift to resolve as part of this change

All four verified in this pass:

1. **`docs/CONTRACT.md` §1 says "There are three entry points."** There are four —
   `package.json` `exports` lists `.`, `./markdown`, `./google`, `./testing`. `./google` has existed
   since PR #1.
2. **The §1 table has no `shorthand-core/google` row at all**, and **`docs/CONTRACT.md` contains zero
   occurrences of the string "google"** (verified: `grep -in "google" docs/CONTRACT.md` returns
   nothing). The document that describes the public surface does not mention an entire entry point.
   Add the row.
3. **`docs/CONTRACT.md:62` cites `test/consumer-imports.test.ts`, which does not exist.** Verified
   against a directory listing of `test/` — there is no such file. `docs/DESIGN.md:246` cites it too.
   The contract document claims a hole is closed by a test that is not there. Either write the test or
   correct both documents; do not leave the claim standing.
4. The §1 `shorthand-core/testing` row must gain the credentials-conformance exports.

Item 3 is the serious one: it is not stale prose, it is a false assurance in the document that
external sink implementers are told is "everything you need."

---

## New and changed tests

Beyond the deletions and the two retargeted harness-leak tests already covered:

**Core, credentials reader:**

- Every malformed-file shape maps to `tokenError("not-authorized", …)` with the offending field named:
  absent file, non-JSON bytes, wrong `type`, and each of `client_id`, `client_secret`, `refresh_token`,
  `document_id` missing in turn. Today none of these is covered, and the first four currently *throw*.
- Unknown top-level keys are ignored (forward compatibility with a newer writer).
- A valid file produces a working `UserRefreshClient` — asserted through the existing
  `refreshAccessToken` test seam, not over the network.
- The single-client caching property survives the switch to `UserRefreshClient.fromJSON`: two
  `getAccessToken()` calls perform one refresh. This mirrors the existing caching test and is the
  regression guard for the fix recorded in the sink spec's "Follow-up fix" section.

**Core, conformance fixture (testing its own artifact):**

- `GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS` run against a **deliberately correct** in-repo writer —
  all pass.
- Run against **deliberately wrong** writers, one per scenario, each failing the scenario it should
  and only that one: wrong path, camelCase fields, missing `type`, mode `0644`, a writer that
  preserves `folder_id` across an overwrite (the anti-`mergeCredentials` scenario), a writer that
  leaves its temp file behind.
- The second half is the one that matters. A conformance suite that has only ever been run against a
  correct implementation is not evidence of anything — the same mutation discipline `AGENTS.md`
  L82-83 already requires for the enhancement-preamble tests.

**Core, scope guard:**

- The existing negative test, unchanged.
- A new positive test: at least one `drive.file` match exists.
- Both verified by mutation — delete `GOOGLE_DOCS_SCOPE` and confirm the positive test fails; add a
  second scope and confirm the negative test fails.

---

## Explicitly out of scope

Named so their absence reads as a decision.

- **The `shorthand-config` app itself** — its Rust consent port, its UI, its distribution, its
  signing, and the bundle-vs-install question. All in `2026-08-19-shorthand-config-app-brief.md`.
- **The enhance/capture wiring** — sink selection in core's CLI, the `addDocumentTab` call that mints
  a `tabId`, the per-capture state file's schema and lifecycle, and the live end-to-end write. A
  separate spec. This document fixes only *where* that state does not go.
- **Installing other Shorthand components** — the transcription app, the Obsidian plugin.
- **Claude Code / Codex CLI install-and-configure guidance.**
- **Swapping the Claude Agent SDK** for another backend, and the `AgentClient` port work in core that
  would enable it.
- **Licensing and entitlement.**
- **The keychain implementation itself** — deferred with a route recorded above, not designed.
- **The remaining empirical open questions from the sink spec** — whether `addDocumentTab` behaves as
  documented against a real document, whether writing every ~25 s buries a human's Version History,
  whether `about.get` returns the user's email under `drive.file` alone. All still open; all belong to
  the wiring spec.

---

## Open questions

1. **Does `bun build --compile` work on macOS?** Windows is answered (132 MB working binary, Agent SDK
   included). macOS is **untested**, and it is the platform where the answer is load-bearing — it is
   the precondition for the keychain route. Bun documents cross-compilation targets; none were run.
   Highest-value item on this list.
2. **Does the compiled binary read the credentials file correctly?** Not exercised: no CLI command
   constructs `FileTokenProvider` today. Worth checking once the wiring spec gives one a call site,
   because file-path resolution and `os.homedir()` behaviour inside a single-file executable are
   exactly the kind of thing that differs.
3. **Windows ACL on the credentials file.** `0600` is applied on non-Windows only; Windows inherits
   `%APPDATA%`. Worth fixing. Whoever fixes it should first confirm what is actually inherited rather
   than assuming.
4. **The `cmdkey.exe` Windows keychain result needs re-running with its method recorded** — read API,
   generic vs domain credential, `TargetName`. As it stands it is not reproducible.
5. **Do `@napi-rs/keyring` and the Rust `keyring` crate agree on item naming?** Both wrap `keyring-rs`,
   but Windows `TargetName` composition and the macOS keychain choice (legacy vs data-protection)
   depend on which `keyring-rs` version each wraps, and `keyring-rs` went through a 3.x→4.x store
   split. A mismatch means one side writes an item the other cannot find, with no error saying so.
   Roughly ten minutes to verify by writing from Rust and reading from the other side; **must** be
   verified before any keychain work is committed to. (If core ends up compiled-Rust-adjacent rather
   than JS, this simplifies — but that is not decided.)
6. **How does `shorthand-config` learn connected-state?** It will want to render "you are connected to
   Google." With no read command in core, its options are: read the file it wrote (it knows the path —
   it satisfies the path scenario), or track its own state separately. Reading its own file is the
   obvious answer and does not violate one-writer-per-file (that rule governs writes), but it does
   mean `shorthand-config` parsing a format core defines — which is precisely what the conformance
   fixture is for. Confirm during the app's design.
7. **Does the credentials file need a format version field?** Not proposed above, deliberately —
   `type: "authorized_user"` plus ignore-unknown-keys covers forward compatibility for additive
   changes, and a version field invites a migration framework nobody needs yet. Revisit if a
   non-additive change is ever contemplated.

---

## Verification

How anyone confirms this was implemented as specified.

**The boundary holds:**

1. `grep -rniE "listenForRedirect|buildAuthorizationUrl|exchangeCode|generatePkceChallenge|ensureContainerDoc|trigger_onepick|google-login" src/ bin/` returns nothing.
   *The prior draft's version of this step was unrunnable*: it grepped for the bare word `oauth`,
   which still matches `src/google/file-token-provider.ts:102` — a doc comment citing
   `node_modules/google-auth-library/build/src/auth/oauth2client.js`. That hit is benign and expected.
   Scope the pattern to identifiers, as above, or state the expected hit.
2. `bun run typecheck`, `bun test`, `bun run build` and `bun run test:e2e` all pass — the four-command
   gate from `AGENTS.md` L14-26.
3. `bun bin/shorthand-notes.ts google-login` returns exit code 2 and the usage text, and the usage text
   does not mention `google-login`. *The prior draft tested `shorthand-notes --help`, which does not
   exist*: `runCli` (`bin/shorthand-notes.ts:80-97`) dispatches on the first positional and falls
   through to `usage(...)` for anything unrecognised. There is no `--help` flag.
4. The dispatch error string at `bin/shorthand-notes.ts:92` no longer names `google-login`.
5. `package.json` `dependencies` is unchanged.
6. `package.json` `version` is `0.8.0`, and the commit carries `!` plus a `BREAKING CHANGE:` footer
   naming `ensureContainerDoc`, `ContainerDocResult`, `writeCredentials`, and the retyped
   `GoogleCredentials` / `FileTokenProviderOptions`.

**The credentials contract holds:**

7. A file matching the documented shape, placed at `credentialsPath()`, drives a successful
   `FileTokenProvider.getAccessToken()` against real Google.
8. The same file loads without error via `UserRefreshClient.fromJSON` — the ADC-alignment proof.
9. A file with each required field removed in turn produces `tokenError("not-authorized", …)` naming
   that field, and **never throws**. Check by running, not by reading the code.
10. A file with an unknown top-level key still loads.
11. `grep -rn "mergeCredentials\|writeCredentials\|tabId" src/` returns nothing under
    `src/google/file-token-provider.ts`.

**The conformance fixture is real:**

12. `shorthand-config`'s CI runs `describeGoogleCredentialsConformance` against its Rust writer, and
    it passes.
13. Each deliberately-wrong writer in core's own tests fails exactly the scenario it should, and only
    that one. A conformance suite only ever run green proves nothing.
14. `shorthand-config` contains no independently-derived credentials path and no independently-derived
    JSON schema for that file — it satisfies the published contract, and scenario 1 is what proves it.

**The scope guard is intact:**

15. Both repositories' guards pass.
16. Both fail when the `drive.file` constant is deliberately removed. This half is the one that
    matters — a guard that only ever passes proves nothing here.
17. Both fail when a second `googleapis.com/auth/` scope is deliberately introduced.
18. `shorthand-config`'s guard demonstrably scans `.rs` files under `src-tauri/`: introduce a second
    scope **in a Rust file** and confirm it fails. A guard that only scans the frontend passes
    vacuously.

**The documentation is true:**

19. `docs/CONTRACT.md` §1 says four entry points, has a `shorthand-core/google` row, and lists the new
    `shorthand-core/testing` exports.
20. Either `test/consumer-imports.test.ts` exists, or `docs/CONTRACT.md:62` and `docs/DESIGN.md:246`
    no longer claim it does.
