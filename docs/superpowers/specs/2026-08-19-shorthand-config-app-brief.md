# `shorthand-config` — brief for a repository that does not exist yet

**Status: BRIEF, not a design spec, and deliberately not a plan.** It is a handoff document for a
repository — `mshish/shorthand-config` — that has **not been scaffolded**. Nothing here creates it.

**This copy lives in `shorthand-core` only because there is nowhere else to put it.** When the repo is
created, this file moves there and this copy is deleted. That matters: the research notes in the back
half (Tauri signing, updater behaviour, the Handy fork audit) are facts about a repo that does not
exist, and they will go stale sitting in core's spec directory. Do not treat their presence here as
evidence they are still current.

**Not committed to git — written to disk only, at the user's request, until reviewed.**

## The one-way dependency, stated first because it governs everything

> **`shorthand-config` depends on `shorthand-core`. `shorthand-core` must never depend on
> `shorthand-config`** — not on its name, its Google OAuth client, its install location, or its
> existence.

The human's words: *"config will be coupled to core but we don't want the reverse to be true."*

Every design choice below that looks like extra work — reimplementing a working TypeScript module in
Rust, duplicating a scope constant instead of importing it, reading a contract out of a published
fixture instead of calling core's code — is that constraint being paid for. It is worth naming that
plainly so nobody later "simplifies" one of them by adding an import in the forbidden direction.

The companion document is `2026-08-19-google-oauth-boundary-design.md`, which specifies core's side:
what core deletes, and the credentials-file contract this app must satisfy. **Read it first.** This
document does not restate that contract; it points at it.

---

## What this app is for

A separate, proprietary, cross-platform desktop app (Windows + macOS required, Linux nice-to-have)
that is the paid product's value surface. It is explicitly **not** a DIY-prevention mechanism — the
human is fine with a technical organization duplicating the whole stack from the open repos. What it
sells is hand-holding for a non-technical individual who already pays for Claude or ChatGPT and has
never touched a CLI.

### Technology: Tauri 2.x

Same stack as the existing Shorthand fork. Carried forward from prior research: Rust + TypeScript
already known, small bundle, built-in updater, loopback OAuth straightforward from Rust. **The prior
brief flagged this as "a recommendation, not yet stress-tested against this app's specific
requirements," and that caveat still stands** — in particular, whether this app needs to supervise or
restart a background process the way the existing fork does is unresolved and bears on the choice.

---

## v1 scope

Three things, and only three:

1. **Installable** — a real signed-or-shippable artifact a non-technical user can run.
2. **Auto-updating** — Tauri's updater wired end to end, including the release pipeline that feeds it.
3. **Google consent and the Docs sink usable** — the consent flow, target selection, and writing the
   credentials file.

Everything the earlier brief imagined beyond that is deferred: installing the transcription app and
the Obsidian plugin, Claude CLI detection and login guidance, agent-backend selection, licensing and
entitlement UI, telemetry posture.

**Point 3 carries a dependency this app cannot satisfy on its own.** `GoogleDocsNoteSink` requires a
`tabId`, which is minted by core via `addDocumentTab` — a call that has **zero call sites** in core
today (verified). Until the separate enhance/capture wiring spec lands, a credential this app obtains
drives nothing. v1 is not reachable from this brief alone, and that is not a gap in this brief.

---

## The user-facing auth flow, in full

This is what a real person does. It is stated first, and in this much detail, because everything after
it is machinery that must not leak into it.

1. The user clicks **Connect Google** in `shorthand-config`.
2. Their **system browser** opens on Google's own consent screen.
3. They sign in to their Google account and grant `drive.file`.
4. In the **same browser round-trip**, Google's Picker opens (`trigger_onepick=true`) and they click
   the Google Doc they want their notes written into.
5. The browser redirects to `http://127.0.0.1:PORT/callback`, which the app is listening on. The page
   says they can close the tab.
6. The app exchanges the code, writes the credentials file, and shows "connected".

**That is the entire user-visible flow. Six steps, no typing, no configuration.**

### The user never sees, enters, or supplies an OAuth client id or secret

**`shorthand-config` ships its own OAuth client id and secret, embedded in the binary.** Not the
user's. Not core's. Its own, registered in a Google Cloud project this app owns.

**This is Google's documented standard path for an installed/desktop-app OAuth client**, where the
client secret is explicitly *not* treated as confidential — the security of the flow comes from PKCE
and the loopback redirect, not from the secret being hidden. Per the house rule about following the
standard path: this *is* the standard path, and it is being followed rather than adapted. Deviating
from it — asking a user to register their own Google Cloud project, create OAuth credentials, and
paste two strings into a text box — is the single most reliable way to lose a non-technical user, and
there is no security argument that would justify it, because the secret is not a secret for this client
type.

**The user is never asked for a Google Cloud project, an API key, a client id, a client secret, a
redirect URI, a port, or a scope.** If any of those appears in the UI, the design has gone wrong.

### Why `client_id` and `client_secret` are in the credentials file anyway

They are, and this is **invisible to the user** — it is a file on disk they never open.

The reason is narrow and mechanical: **core has to refresh access tokens later, and refreshing a
refresh token requires the OAuth client that issued it.** A refresh token is bound to its issuing
client; presenting it with any other client's credentials fails. So core needs those two values at
refresh time.

Core cannot get them any other way without breaking the required dependency direction. Compiling them
into core would embed this app's Google identity inside core. Passing them as environment variables
would make core's behaviour depend on how it was launched. Putting them in the file core already reads
means core defines a contract and *something* satisfies it, while knowing nothing about
`shorthand-config`. The full argument, with the rejected alternatives, is in the boundary spec under
"`client_id` and `client_secret` move INTO the file".

The file is also the reason this app must ship *its own* client rather than reusing anything: see
"This app registers its own Google Cloud OAuth client" below, and the re-consent consequence it
carries.

**Explicitly out of scope, mentioned only so its absence is a decision:** a "bring your own OAuth
client" escape hatch for power users. The file format would already accommodate it — core reads
whatever `client_id`/`client_secret` the file carries — but no UI, no import path, and no support for
it is designed, and it must not influence the v1 flow above.

---

## The consent flow is REIMPLEMENTED in Rust, from a verified reference

**This is a reimplementation, not a file move.** The human explicitly accepted the cost: *"I don't
care about how long/much work."*

The TypeScript in `shorthand-core` is the **reference implementation**. It was verified working
against real Google, interactively, including the Picker round-trip. It is deleted from core once the
port works (see the boundary spec). Port from it while it still exists; do not rediscover any of it.

### File-by-file reference map

| Reference (in `shorthand-core`) | What ports to Rust |
| --- | --- |
| `src/google/oauth.ts` L6-14 — `generatePkceChallenge` | PKCE verifier + S256 challenge. The TS delegates to `google-auth-library`'s `generateCodeVerifierAsync()`; Rust does it directly (random verifier, SHA-256, base64url-no-padding). |
| `src/google/oauth.ts` L16-35 — `buildAuthorizationUrl` | The authorization URL and **every one of its query parameters**. See "Non-obvious rules" — this function is small and every line of it is load-bearing. |
| `src/google/oauth.ts` L39-57 — `listenForRedirect` | The `127.0.0.1` loopback HTTP listener. Reads `code` and `picked_file_ids` from the query, responds with a human-readable page, closes the server. `picked_file_ids` is **comma-separated**, and empty entries must be filtered (L51). |
| `src/google/oauth.ts` L61-72 — `exchangeCode` | The token exchange: `code` + `code_verifier` + `redirect_uri` → tokens. **Must fail loudly when no `refresh_token` comes back** (L68-70) — a silent absence here produces a credential that works exactly once. |
| `src/google/container-doc.ts` L15-116 — `ensureContainerDoc` | Drive folder create, Docs doc create, and the reparent. The single most error-prone piece; see "Non-obvious rules". |
| `bin/shorthand-notes.ts` L485-557 — `runGoogleLogin` | The orchestration: build client → PKCE → URL → open browser → listen → exchange → set credentials on the client → create-or-pick target → write file. Also `describeContainerDocOutcome` (the four-way "what actually happened" message) and `openInBrowser`. |
| `src/google/file-token-provider.ts` L18-22 — `writeCredentials` | Only as a shape reference. The Rust writer must satisfy the **new** contract in the boundary spec (ADC-aligned, `snake_case`, no `tab_id`, atomic write-then-rename), not this function's current behaviour. |

### Non-obvious rules that MUST survive the port

Each of these is a rule where the obvious implementation is wrong and the failure is quiet.

**1. The Drive reparent needs BOTH `addParents` and `removeParents`.**
`container-doc.ts` L84-106, and its comment records the source: Google's `files.update` documentation
states a file can only have one parent, and update requests must use `addParents` **and**
`removeParents` to modify the parents list. Every file this flow touches already has a parent — a
freshly created doc is parented to My Drive root, a picker-selected doc is parented wherever the user
keeps it. So: `files.get(fileId, fields: "parents")` first, then pass those back as a
**comma-separated string** in `removeParents` on the same `files.update` call. `addParents` alone
either fails or produces the multi-parent state Google does not support.

**2. The reparent runs even when the document already existed.**
`container-doc.ts` L75-82. A user who did picker-based login (documentId only, no folder) and later
runs the create flow still needs their existing doc moved into the new folder. Guarding the reparent
behind "did we just create the doc" is the natural mistake and it silently leaves the doc outside the
folder.

**3. Folder-created-then-failed must name the orphaned folder in the error.**
`container-doc.ts` L52-59, L109-115. Nothing is persisted until after the whole sequence succeeds, so
a failure after folder creation leaves a folder in the user's Drive that nothing records. A bare
rethrow means the user cannot find it and a retry creates a second one. The error must carry the
folder id. This is a **UX rule that looks like an implementation detail**, which is why it is easy to
drop in a rewrite.

**4. `trigger_onepick=true` — and only when there is something to pick.**
`oauth.ts` L33. Appending it to the standard authorization URL opens the desktop Picker in the same
round-trip, and the redirect then carries `picked_file_ids` alongside `code`. No separate Picker API
key or App ID is needed. Omit it in the create flow — there is nothing to pick when the app is about
to create the target itself.

**5. `access_type=offline` and `prompt=consent`, both, every time.**
`oauth.ts` L29-30. Without `access_type=offline` Google issues no refresh token at all. Without
`prompt=consent` Google may omit the refresh token on a *re-authorization* of an already-granted
client, because it only issues one on first grant. The failure is asymmetric and nasty: it works
during development (first grant) and fails for the second consent a user ever performs.

**6. PKCE, S256, with the verifier carried across the browser round-trip.**
`oauth.ts` L31-32 sets `code_challenge` and `code_challenge_method=S256`; L67 sends `codeVerifier` on
exchange. The loopback redirect is the standard installed-app model — a Desktop-type OAuth client is
issued a client secret, and shipping it in the binary is Google's documented standard path for a
public client. Secret + PKCE + `http://127.0.0.1:PORT` is the whole model; the OOB flow is dead.

**7. `drive.file` only, and never combined with another scope.**
`GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/drive.file"` (`src/google/docs-sink.ts:7`). The
desktop Picker flow enforces the never-combined half itself — it rejects combined-scope requests —
which means identity scopes (`openid`, `email`) would need a separate consent flow if account linking
is ever wanted. Do not widen for any convenience. The scope guard below is the mechanical enforcement.

**8. Set the refresh token on the client explicitly after exchange.**
`bin/shorthand-notes.ts` L508-511, with its reason recorded: every downstream Drive/Docs call in the
flow authenticates with it, and relying on `getToken()` having set it as a side effect depends on an
unverified library internal. The Rust port has different libraries and the same hazard — be explicit.

### What the app writes

The credentials file, directly, in Rust. **The contract is specified in
`2026-08-19-google-oauth-boundary-design.md` and is not restated here** — deliberately, so there is
one definition. In summary only: ADC `authorized_user` shape (`type`, `client_id`, `client_secret`,
`refresh_token`) plus `document_id` and optional `folder_id`, `snake_case` throughout, no `tab_id`,
`0600` on non-Windows, atomic write-then-rename, at the path core's `credentialsPath()` resolves.

**Compliance is proven mechanically, not by reading.** Core publishes a credentials conformance
fixture from `shorthand-core/testing`, modelled on the `NOTE_SINK_CONFORMANCE_SCENARIOS` mechanism it
already ships for external sink implementers. `shorthand-config` runs it in CI against its own writer.
That requires Bun (or Node plus a TS loader) **in CI only** — not in the app, not in the installer, not
at runtime.

### This app registers its own Google Cloud OAuth client

New client, new project, owned by this app. **Consequence, stated plainly and accepted: a refresh
token is bound to the OAuth client that issued it, so every existing `google-credentials.json` becomes
unusable and every existing user must re-consent.** There is no migration and none is wanted — the
affected population is one developer's test files.

**Open: the *mechanics* of embedding the client id and secret in a Tauri build.** That they are
embedded is settled and is the standard path (see "The user-facing auth flow, in full"); *how* is not —
build-time constant via Rust `env!`, `tauri.conf.json`, or something else. Note the constraint this
creates for CI: whatever the mechanism, the values must reach a release build, which means secrets in
the release workflow.

### The scope guard, copied and adapted

Core ships `test/google-scope-guard.test.ts`: walk the source tree, match
`googleapis\.com/auth/[\w.]+`, fail on anything that is not `drive.file`. Copy it here — copy, not
move; both repos run it.

**Do not copy it literally.** Core's version walks `src/` and `bin/` for files ending `.ts`. This
app's consent code is **Rust under `src-tauri/`**. A literal copy scans the frontend, finds zero
matches, and passes — and core's guard has a verified weakness that it also passes on zero matches, so
a literal copy would be guaranteed vacuous rather than merely possibly so. The copy must:

- walk `src-tauri/` for `.rs` **and** `src/` for `.ts`/`.tsx` (a URL can be built in either place);
- carry a **positive** assertion — at least one `drive.file` match must exist — anchored on the Rust
  file that actually builds the authorization URL, not on any file that happens to mention a scope;
- be verified by mutation: remove the constant and confirm the positive half fails; add a second scope
  in a `.rs` file and confirm the negative half fails.

The scope string is **duplicated rather than imported**. Importing it would mean a Rust app taking a
build dependency on core's raw-TypeScript export map for one string literal — the forbidden direction
in miniature. The duplication is safe *because* both guards exist. Record that reason next to the
constant, not merely the fact of duplication.

---

## Update distribution: private source repo, separate public releases repo

Source lives in the private `mshish/shorthand-config`. **Releases are published to a separate public
repository**, and `plugins.updater.endpoints` points there.

The reason is mechanical: Tauri's updater fetches its endpoint over plain, unauthenticated HTTPS. It
has nowhere to put a token. A public releases repo makes the endpoint trivially reachable and removes
the question.

> **UNVERIFIED:** that a private repository's release assets require authentication to download could
> not be confirmed against a GitHub primary source in this research pass. Widely asserted, plausible,
> unconfirmed. **The design does not depend on it** — a public releases repo is a fine answer
> regardless — so the gap is not load-bearing.

**This must be settled before the first release, not after.** `plugins.updater.endpoints` is baked
into every shipped binary. An installed app can only ever be updated from the endpoint it shipped
with, so changing it later strands every existing install.

The second half of the human's stated goal — *"options on what to open source and when"* — is served
by this split too: source private, releases public, and the decision to open a component later is a
repository-visibility change rather than an architectural one.

---

## What is, and is not, reusable from the Handy fork

`2026-08-18-setup-config-app-brief.md` L59-63 said to check `SIGNING_AND_UPDATES.md` in the Handy fork
"since some of the CI/signing pipeline may already exist there and be reusable." **That is largely
false.** Corrected here.

**Verified in this pass** (2026-08-19, working tree of `D:\tools\Handy`, branch `shorthand`, against
`upstream/main` = `cjpais/Handy`):

- `git diff --stat upstream/main -- .github` produces **no output** — the fork's `.github/` is
  byte-identical to upstream. Zero workflow files modified.
- `SIGNING_AND_UPDATES.md:3` reads *"Fork-only. Nothing here is set up yet"*.
- `.github/workflows/build.yml` is **47,417 bytes**.
- `src-tauri/nsis/installer.nsi` is **1,085 lines**.
- `src-tauri/Cargo.toml:33` — `tauri = "2.11.5"`; `:101` — `tauri-plugin-updater = "2.10.0"`.
  `package.json:25` — `@tauri-apps/api ^2.11.0`.
- `.github/workflows/build.yml:515` uses `tauri-apps/tauri-action@v0`.

> **Provenance note.** The claim that *GitHub Actions is disabled at the repository level on
> `mshish/shorthand`* is a **GitHub repository setting, not observable in a working tree**. It cannot
> be verified from the checkout and is recorded here as **UNVERIFIED from this pass** — confirm in the
> repository's Settings → Actions before relying on it. The conclusion it supports (there is no
> running pipeline to inherit) is independently established by the byte-identical `.github/` above.

**Actively harmful to copy from `src-tauri/tauri.conf.json`** (all verified by reading it):

- `:81` `plugins.updater.pubkey` — cjpais's minisign public key. Updates signed with our key would be
  rejected; updates signed with theirs we cannot produce.
- `:82` `plugins.updater.endpoints` — points at upstream's feed. The fork's own briefing already names
  the consequence: *"Shorthand offers to install upstream Handy over itself."*
- `:73` `bundle.windows.signCommand` — `trusted-signing-cli -e https://eus.codesigning.azure.net/ -a CJ-Signing -c cjpais-dev -d Handy %1`. Points at an Azure account we do not own.

**Genuinely reusable:**

- `src/components/update-checker/UpdateChecker.tsx` — a working check → `downloadAndInstall` →
  `relaunch` flow. (The directory also holds `portableInstaller.ts` and its test, which are
  Handy-specific.)
- `"updater:default"` in `src-tauri/capabilities/default.json:10` and `desktop.json:10`.
- The macOS keychain certificate-import CI step, `.github/workflows/build.yml` L228-242 — the
  `security create-keychain` / `import` / `set-key-partition-list` / `find-identity` sequence, which is
  fiddly and generic.
- The draft-release-then-fill pattern in `release.yml`.

**Not reusable:** `build.yml` as a whole — 47 KB, roughly 40 steps, almost all Vulkan / ONNX /
OpenBLAS audio-stack machinery with maybe four generic steps. And `installer.nsi`, 1,085 lines
existing for Handy's own installer needs.

`shorthand-config` has no audio stack. Its build is an ordinary Tauri build and the standard
`tauri-action` path fits it. Copying Handy's workflow imports a large amount of machinery for problems
this app does not have.

---

## Tauri updater and signing facts

Captured so implementation does not re-derive them. **Provenance is marked on every item.** Items
marked UNVERIFIED come from an earlier research pass and were *not* re-read against a primary source
in this one; they are plausible and were acted on before, which is not the same as confirmed.

**Update-feed signing:**

- Minisign update signing is free, required, and cannot be disabled. Losing the private key means never
  being able to update already-installed apps — key custody is a real operational decision, not a
  formality. *(Source: Tauri updater documentation, earlier pass. UNVERIFIED in this pass.)*
- The key is supplied via `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  **`.env` files do not work for these.** *(Source: Tauri's own documentation warns this, earlier pass.
  **UNVERIFIED** in this pass — re-read before designing the CI around it, since it determines whether
  local release builds are possible at all.)*

**Configuration:**

- `bundle.createUpdaterArtifacts` defaults to `false` and must be `true`; without it there are no
  update artifacts. *(Handy sets it — `tauri.conf.json:28` — which is corroboration that it is real,
  though not of the default. Default value UNVERIFIED in this pass.)*
- Set `bundle.targets` explicitly to `["nsis", "app", "dmg"]`. With `targets: "all"` — which is what
  Handy has, `tauri.conf.json:29` — `tauri-action`'s `updaterJsonPreferNsis` defaults to `false` "for
  legacy reasons," and the generated `latest.json` points at the `.msi` rather than the `.exe`.
  *(**UNVERIFIED** in this pass: the default's value and the "legacy reasons" wording come from
  `tauri-action`'s own docs, earlier pass. Verify against `tauri-action`'s source — it is a one-line
  check and it determines whether Windows updates work at all.)*
- Windows: `plugins.updater.windows.installMode: "passive"` is the documented recommendation, and
  Windows **auto-exits the app during install** — a documented limitation, not a bug. `.on_before_exit()`
  is the hook for anything that must run first. *(Earlier pass. UNVERIFIED here.)*
- macOS: the update artifact is `myapp.app.tar.gz` plus its `.sig`. The DMG is a first-install artifact
  only and is never an update artifact. *(Earlier pass. UNVERIFIED here.)*

**Code signing, cost, necessity:**

- **Windows Authenticode is cosmetic.** Unsigned, the app runs; the user sees a SmartScreen warning.
  Ship unsigned initially and add signing later as a one-line `signCommand` change. *(Earlier pass.
  UNVERIFIED here — but low-risk, since the failure mode is a warning rather than a block.)*
- **macOS Developer ID plus notarization is effectively required.** Unsigned macOS apps report "is
  broken and cannot be started," indistinguishable from a corrupt download to a non-technical user.
  $99/yr Apple Developer Program. *(Earlier pass. UNVERIFIED here, though the "is broken" string is
  widely reproduced.)*
- **Azure Trusted Signing has been renamed Azure Artifact Signing**, ~$120/yr Basic tier, and Tauri now
  documents `artifact-signing-cli` rather than the older `trusted-signing-cli` that Handy's config
  still uses (`tauri.conf.json:73`). *(**UNVERIFIED** — rename, price and the CLI change all come from
  an earlier pass. The *fact that Handy uses the old CLI name* is verified; the rename is not.)*
- **Individual (non-organization) developers must be located in the US or Canada to obtain a
  public-trust certificate** through that service. *(**UNVERIFIED**, earlier pass. This is an
  eligibility gate — if wrong in either direction it changes the Windows signing plan entirely, so
  verify before budgeting for it.)*
- `tauri-action` **v1 exists, released 2026-06-29**; Handy is still on `@v0` (verified: `build.yml:515`).
  *(The v1 existence and its release date are **UNVERIFIED** — earlier pass. Handy's `@v0` pin is
  verified.)*

**No OAuth precedent exists in Handy at all** — no `tauri-plugin-deep-link`, no `tauri-plugin-oauth`,
no OAuth code of any kind. The desktop OAuth loopback flow here is greenfield, and its reference is
core's own `oauth.ts`.

**On `tauri-plugin-stronghold`:** it is not a keychain plugin. It derives its key from a password,
which core would need to hold as a hardcoded constant to read anything — demonstrably worse than a
plain file. *(Additionally: a Tauri maintainer is reported to have said the plugin will be removed in
v3. **UNVERIFIED** — earlier pass, no primary source re-read.)* This is **not** an argument that
keychains are rejected. The actual keychain route — `@napi-rs/keyring` / the Rust `keyring` crate, a
shared Apple team identity, a `keychain-access-groups` entitlement — is set out in the boundary spec's
"OS keychain storage: deferred, not foreclosed" section, and it is wanted in the not too distant
future. **The Rust rewrite makes it easier**: this app is already a signed Rust binary, so the writer
side is nearly free; only core's side needs the compiled-and-signed work.

---

## Bundle vs. install: re-argued

**This is the one decision here that is not settled.** It is a recommendation to confirm or flip.

The question: does `shorthand-config` **bundle** `shorthand-core` inside its own artifact, or
**install and manage** core as a separately-versioned component?

The prior draft recommended "install as a separate component" on grounds that do not survive scrutiny.
Correcting the record first, because the corrections change the answer.

### What the prior argument got wrong

**(a) There is no core artifact to install, and creating one was invisible in the cost line.**
Verified: core's `package.json` has `"private": true`, and its `exports` map points at raw `.ts`
(`".": "./src/index.ts"`, `"./google": "./src/google.ts"`, …). Distribution today is `github:mshish/shorthand-core#<tag>` plus a
build step. A distribution channel, an artifact format, a version manifest, and macOS signing for core
**all do not exist**. "Install as a component" was quietly proposing to build all four.

**(b) The claimed saving was overstated.** The argument was that a core-only fix reaches users without
re-signing and re-notarizing the desktop app. But core must eventually be signed by the **same Apple
team** anyway — that is the whole keychain route — so a core-only release still needs signing and
notarization. The saving is real but smaller than stated: one artifact instead of two, not zero
signing instead of some.

**(c) Replacing a running core subprocess on Windows is the classic file-lock problem, and it went
unmentioned.** Windows will not let you overwrite an executable that is running. Any
download-and-replace flow needs a stop / replace / restart dance, or the rename-then-replace trick, or
a helper process. That is exactly the machinery an updater exists to provide for the *app*, and it
would have to be built again for the component.

**(d) The human's goal has two halves and only one was argued.** The stated goal is *"easier updates
AND options on what to open source and when."* The prior draft argued updates only. The open-source
half actually favours separation **more strongly** than the update half does: a separately-distributed
core is a component whose license and visibility can change without touching the proprietary app.

### The new empirical fact

> **Verified empirically on Windows 11, Bun 1.3.14, 2026-08-19, against `shorthand-core` at `main`:**
> `bun build bin/shorthand-notes.ts --compile` produces a **working 132,004,352-byte (~132 MB)
> standalone executable** with no Node runtime required. It bundles 1,279 modules including
> `@anthropic-ai/claude-agent-sdk` (no `--external` passed), and a full `enhance --dry-run` ran end to
> end against a live `claude` login. **macOS and Linux were not tested — treat them as UNVERIFIED.**
> Full detail is in the boundary spec's "The runtime prerequisite, answered".

This cuts both ways and should be reported as such rather than pressed into service for one side:

- **Toward bundling:** one artifact, no runtime to detect or install, nothing to version-skew.
- **Toward a managed component:** there *can* be a core artifact now — a single file to fetch and
  replace, rather than a package plus `node_modules`. Objection (a) is partly answered.
- **Neutral-to-negative for both:** 132 MB is a real number. It is a large thing to bundle into a
  Tauri app whose own footprint is measured in single-digit megabytes, and a large thing to
  re-download on every component update.
- **Unchanged:** the Windows file-lock problem, which applies to any replace-while-running flow.

### The third option the prior draft did not consider

**Bundle for v1, behind a resolver.**

Core already establishes this exact shape. `detectShorthandExecutable` (`src/config.ts:12-44`)
resolves in order: explicit override → `SHORTHAND_BIN` env var → `PATH` → conventional per-platform
install locations → a bare-name fallback so `spawn` surfaces a clear `ENOENT`. `shorthand-config`
resolves `shorthand-notes` the same way, with **a bundled copy as the final fallback instead of a bare
name**.

What that buys: v1 gets bundling's simplicity — one release, welded versions, nothing to detect that
can fail. And switching to a managed component later becomes **a change to one resolver function
plus the distribution work**, rather than an unpicking project. The seam is in place from day one and
costs approximately nothing, because the resolver has to exist anyway to support a developer pointing
at a local build.

### Recommendation

**Bundle for v1, behind a resolver. Marked flippable.**

The decisive argument is not that bundling is better in the long run — it may well not be. It is that
**the separation's cost is entirely front-loaded and its payoff is entirely in unscheduled work.** A
distribution channel, an artifact format, a version manifest, macOS signing for core, and a
Windows-safe replace-while-running flow are five real projects, and v1 has exactly one managed
component to justify them. The resolver keeps the option open at near-zero cost, which is the thing
the prior draft's either/or framing had no room for.

**The honest counter, which is why this is flippable:** the open-source half of the goal favours
separation, and it favours it *now* rather than later — a bundled core is a core whose visibility is
entangled with the proprietary app's release. If the intent is to open core's distribution soon, or if
the follow-on components (transcription app, Obsidian plugin) are actually scheduled rather than
aspirational, the component-management layer gets built regardless and bundling was the detour.

**Also unresolved and bearing on this:** whether a 132 MB payload is acceptable inside the installer at
all, and whether `bun build --compile` works on macOS (UNVERIFIED — untested).

---

## Open questions

1. **Does `bun build --compile` work on macOS?** Windows is answered. macOS is untested and is where
   the answer matters most — it is the precondition for the keychain route and it bears on bundling.
2. **Where do the OAuth client id and secret live in a Tauri build?** Build-time constant via Rust
   `env!`, `tauri.conf.json`, or something else — and how they reach a release build without leaking
   into the source repo.
3. **Linux.** "Nice to have" is not a scope. Whether a Linux artifact ships in v1 and in what packaging
   format is unresolved, and Tauri's updater has its own per-format constraints there.
4. **Does this app supervise a background process?** The prior brief flagged this as the untested
   assumption in the Tauri recommendation. It bears on the resolver design and on bundling.
5. **How does the app learn connected-state** — "you are connected to Google, targeting document X"?
   Reading back the file it wrote is the obvious answer and does not violate one-writer-per-file (that
   rule governs writes), but it means this app parsing a format core defines — which is what the
   conformance fixture is for. Confirm during design.
6. **Bundle vs. install itself** — recommendation above, awaiting confirmation.
7. **Every item marked UNVERIFIED in the signing and updater section.** Several are cheap to check and
   at least two (`updaterJsonPreferNsis`'s default, the `.env` limitation) change the CI design if
   they are wrong.

---

## Verification

**The consent flow ported correctly:**

1. A full consent round-trip completes: browser opens, user grants `drive.file`, the loopback receives
   `code` **and** `picked_file_ids`, the exchange returns a refresh token, and the file lands.
2. The create flow produces a folder and a document, and the document ends up **inside** the folder —
   check in Drive's UI, not only in the API response.
3. **The reparent rule, tested where it actually bites:** run the picker flow first (document only, no
   folder), then the create flow. The pre-existing document must move into the new folder. This is the
   case the natural implementation gets wrong.
4. Force a failure after folder creation and confirm the error names the orphaned folder's id.
5. A **second** consent by an already-consented user still yields a refresh token — this is what
   `prompt=consent` buys, and the only way to see it fail is to consent twice.

**The credentials file is right:**

6. Core's conformance fixture passes against this app's writer, in CI.
7. `FileTokenProvider.getAccessToken()` succeeds against real Google using a file this app wrote.
8. Re-running consent over an existing file **removes** a `folder_id` the new run does not supply — the
   anti-`mergeCredentials` property. A writer that helpfully preserves fields has reintroduced the
   merge.
9. No independently-derived credentials path exists in this repo, and no independently-derived JSON
   schema for that file.

**The scope guard is intact:**

10. Passes; fails when the `drive.file` constant is removed; fails when a second
    `googleapis.com/auth/` scope is introduced **in a `.rs` file under `src-tauri/`**. The last is the
    one that catches a vacuous copy.

**The updater works:**

11. Install version N from the public releases repository, publish N+1, and confirm the installed app
    detects, downloads and applies it — on Windows **and** macOS. This is the only meaningful test of
    an updater; a green build proves nothing about it.
12. `latest.json` points at the `.exe` on Windows (not the `.msi`) and at the `.app.tar.gz` on macOS
    (not the `.dmg`).
13. `tauri.conf.json` contains no cjpais minisign key, no upstream endpoint, and no `signCommand`
    naming an account we do not own. Grep for `handy`, `cjpais` and `CJ-Signing` as a blunt check.
14. **The signing private key is recoverable by someone other than the person who generated it.**
    Confirm before the first release, not after — the failure mode is permanent.
