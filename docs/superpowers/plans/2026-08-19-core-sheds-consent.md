# Core Sheds the Google Consent Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Work in `D:\tools\shorthand-core\.worktrees\core-sheds-consent`** — the worktree already checked
> out on the existing `feat/core-sheds-consent` branch. Never in `D:\tools\shorthand-core`, which is
> on `main`. The spec and this plan live **outside** that worktree, at absolute paths under
> `D:\tools\shorthand-core\docs\superpowers\`; pass those absolute paths to anyone you delegate a
> task to, because a relative path to either resolves to nothing from where the work happens. Full
> detail in "Global Constraints".

**Goal:** Remove every part of `shorthand-core` that *obtains* a Google credential or a target, and
turn what remains into a pure reader of a credentials file written by somebody else — a file whose
format is Google's own ADC `authorized_user` shape plus two fields of ours, defined by an executable
conformance fixture core ships.

**Architecture:** Deletion first, then re-typing. `src/google/oauth.ts` (the consent round-trip) and
`src/google/container-doc.ts` (creating the target) leave the repo along with the `google-login` CLI
command that drove them. `src/google/file-token-provider.ts` stops writing the credentials file
entirely, gains real validation (a malformed file must return a `TokenResult` error, never throw
into a live capture), and sources `client_id`/`client_secret` from the file rather than from
constructor arguments. A new `src/testing/google-credentials-conformance.ts`, modelled exactly on
the existing `NOTE_SINK_CONFORMANCE_SCENARIOS` mechanism, publishes the file contract as runnable
scenarios plus golden bytes so a writer in another language can prove it conforms.

**Tech Stack:** TypeScript / Bun. `google-auth-library@10.5.0` (already a dependency) — specifically
`UserRefreshClient.fromJSON`, which replaces core's hand-rolled `OAuth2Client` field plumbing. No
dependency is added and none is dropped.

**Spec:** `D:\tools\shorthand-core\docs\superpowers\specs\2026-08-19-google-oauth-boundary-design.md`
— an **absolute path, outside the worktree the work happens in**. `docs/superpowers/` is untracked and
`.gitignore` excludes `.worktrees/`, so the worktree's `docs/` contains only `CONTRACT.md`,
`DESIGN.md` and `original-plan.md`: a relative "read the spec" instruction resolves to nothing there.
Read it before starting; every task below argues from it. This plan is at
`D:\tools\shorthand-core\docs\superpowers\plans\2026-08-19-core-sheds-consent.md`, likewise outside
the worktree. The companion `2026-08-19-shorthand-config-app-brief.md` is **out of scope for this plan
entirely**.

---

## Read this before Task 1: the state you are leaving the repo in

The spec takes an explicit position (its "Sequencing: the deletion lands now" section) and this plan
follows it: **`google-login` is deleted before any replacement exists.** After this plan lands there
is no shipping way to obtain a Google credential until the separate `shorthand-config` Rust app is
built. That is deliberate, not an oversight, and the spec's reasoning is:

1. A credential obtained today buys nothing. `addDocumentTab` has **zero call sites** (verified —
   `grep -rn addDocumentTab src/ bin/ test/` returns nothing), so `GoogleDocsNoteSink` is not
   constructible from persisted state, and `createEnhanceRunner` hardcodes `MarkdownNoteSink`
   (`bin/shorthand-notes.ts:330`). `google-login` writes a file nothing in the shipping product
   reads — its own success message says so.
2. `shorthand-config` will register its own Google OAuth client, which invalidates every refresh
   token `google-login` ever produced. Keeping it alive maintains a second consent implementation
   whose output is dead on arrival.
3. The reader work (renaming fields, dropping `tabId`, deleting the merge, adding validation) is one
   change. Doing it while `google-login` still writes the old shape means keeping two writers alive
   across the transition — the exact thing the one-writer-per-file rule forbids.

If you are executing this plan and this feels wrong, stop and raise it with the human rather than
inventing a stopgap. The spec is explicit: "One thing this deliberately does not do: replace
`google-login` with anything."

---

## Questions for the human

**Do not resolve these silently. Each is a place the spec is under-specified or where I found a fact
that differs from what the spec claims. Every one has a concrete default written into the tasks
below so the plan is executable — but the default is mine, not the spec's, and each is a one-line
change if the answer differs.**

1. **`readCredentials` is retyped, but the spec's `BREAKING CHANGE:` footer list omits it.** The spec
   (verification item 6) names `ensureContainerDoc`, `ContainerDocResult`, `writeCredentials`, and
   the retyped `GoogleCredentials` / `FileTokenProviderOptions`. But `readCredentials` is re-exported
   from `shorthand-core/google` (`src/google.ts:21`) and cannot keep its
   `Promise<GoogleCredentials | undefined>` signature once it validates — "undefined" cannot carry
   *which* field was missing. **Default taken: `readCredentials` returns a discriminated
   `CredentialsReadResult` and is named in the footer alongside the other five.**
2. **`getAccessToken()` fails on a missing `document_id`** — the spec says this twice (its "New and
   changed tests" list, and verification item 9's "each required field"), and its reader-side
   scenario 11 wants a *distinct* error for it. **DECIDED BY THE HUMAN: it must NOT. A missing
   `document_id` does not fail a credential read.** The reasoning, recorded because it also governs
   anything built on top of this: nothing in core reads `document_id` off the credentials file —
   `GoogleDocsNoteSink` takes `documentId` as a constructor option (`src/google/docs-sink.ts:9-14`) —
   so requiring it only makes the file unreadable when absent, for no consumer at all. Leaving it
   optional also preserves room for a "connect now, choose the target next" step in
   `shorthand-config`. **Therefore `getAccessToken()` and `readCredentials` validate only what a token
   actually needs: `type`, `client_id`, `client_secret`, `refresh_token`. `document_id` is optional in
   the validated read result**, exactly like `folder_id`, and this overrides the spec's scenario 11
   and its "each required field" phrasing. This supersedes the spec, deliberately; do not restore the
   spec's version.

   **Do not regress either target-selection flow.** Both must keep working, and both stay inside
   `drive.file`: (a) the user picks an existing Doc through the Picker at auth time
   (`trigger_onepick=true`), and (b) the app creates its own folder and container Doc — the old
   `--create` / `ensureContainerDoc` flow. Which of the two runs, and when, is `shorthand-config`'s
   concern and not this plan's. What *is* this plan's concern is not introducing anything in core
   that would preclude either — and a credential that cannot be read until a target exists precludes
   flow (b)'s obvious ordering.
3. ~~**"Distinct error" cannot mean a distinct error *code*.**~~ **MOOT, resolved by item 2.** This
   asked how the spec's scenario 11 could give a missing `document_id` a "distinct" error when
   `TokenErrorCode` is `"not-authorized" | "revoked" | "transport"` and the spec says the port and its
   error types are unchanged. With the human's decision that a missing `document_id` is not an error
   at all, there is no second error to distinguish. Kept, struck through, so nobody re-derives the
   question. The port and its error types remain unchanged either way.
4. **Where does the "deliberately correct in-repo writer" live?** The spec requires core's own tests
   to run the conformance scenarios against a correct writer, but core must not ship a writer
   (verification 11 greps `writeCredentials` out of `src/google/file-token-provider.ts`). **Default
   taken: a test-only module at `test/fixtures/credentials-writer.ts`.** Nothing under `src/` writes
   the file.
5. **`describeGoogleCredentialsConformance`'s signature has no `support` parameter** in the spec's
   sketch, yet scenario 5 requires the permissions case to be *declared*-skipped like the sink
   suite's `support` flags. **Default taken: added an optional fourth parameter
   `support?: CredentialsConformanceSupport` with one flag, `posixPermissions`.**
6. **Golden bytes require a pinned key order, which the spec never states is part of the contract.**
   A byte-level assertion is meaningless without one. **Default taken: the exact order of the spec's
   "The shape" block — `type`, `client_id`, `client_secret`, `refresh_token`, `document_id`,
   `folder_id`.** The key order is unaffected by item 2's decision: `document_id` keeps its slot and,
   like `folder_id`, is simply **omitted** when absent rather than emitted as `null`. The two golden
   fixtures both carry a `document_id`, so their bytes are unchanged by that decision.
7. **"Each wrong writer fails exactly the scenario it should, and only that one" is not
   achievable.** A writer that omits `type` necessarily fails the `type` scenario, the
   `readCredentials` scenario, the `fromJSON` scenario *and* the golden-bytes scenario. **Default
   taken: each mutation asserts against an explicit expected *set* of failing scenario names** — same
   discipline (every mutation is detected, and detected specifically), achievable wording.
8. **The retargeted harness-leak tests.** The spec prescribes asserting "structurally" by calling
   `stripGoogleOAuthEnv` and `run()`'s env-construction directly, using `init-note` as a cheap
   subject. Literally done, that proves only that `stripGoogleOAuthEnv` works — nothing proves `run()`
   still calls it, and `init-note` cannot report what env it received. **Default taken: a four-line
   `test/fixtures/print-google-env.mjs` probe passed as `run()`'s `entry`**, so the test asserts on
   the env `run()` actually handed to `spawn`. The spec's "strictly weaker" note is preserved in the
   test comment and remains true: it proves the strip happens, not that a consent flow cannot start.
9. **`shorthand-core/testing` becomes a barrel spanning two unrelated subjects.** The spec recommends
   the barrel but does not consider that a Markdown-sink implementer importing it would now pull
   `google-auth-library` and `node:fs` into their graph — today `sink-conformance.ts` has zero
   imports beyond two type-only ones. **Default taken: the barrel, with the Google module importing
   `google-auth-library` and `../google/file-token-provider.js` via `await import(...)` inside the
   scenarios that need them**, so the static graph gains nothing.
10. **`refreshAccessToken`'s seam signature must change** and the spec does not say to what. It is
    `(refreshToken: string) => Promise<TokenResult>` today; with `client_id`/`client_secret` now in
    the file, a refresher needs the whole credential. **Default taken:
    `(credentials: GoogleCredentials) => Promise<TokenResult>`.**
11. **The `0600` scenario is skipped on Windows, which is this repo's development platform.** So the
    `mode 0644` mutation test in Task 9 is undetectable locally and only proves anything on a
    non-Windows runner. Recorded, not solved — it is the spec's own "Open questions" item 3 in a
    different guise.
12. **The spec is wrong about `docs/DESIGN.md:246`.** It claims DESIGN.md "cites" the missing
    `test/consumer-imports.test.ts` as though it exists. Verified: `docs/DESIGN.md:246` correctly
    says the file "was deleted outright" and explains why. **Only `docs/CONTRACT.md:62` carries the
    false assurance**, and only it is fixed in Task 10.
13. **Per-capture `tabId` state has no executable task.** The spec settles only *where* it does not
    go (not the credentials file) and names `join(shorthandConfigDirectory(env), "captures",
    "<captureId>.json")` as the location — while explicitly deferring the schema, the lifecycle, the
    minting and even *whether it needs a file at all* to the enhance/capture wiring spec. There is
    nothing here to build. Nothing in this plan creates that directory or that file.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **The four-command gate, every task, in this order:**
  `bun test && bun run typecheck && bun run build && bun run test:e2e`.
  All four. `bun test` transpiles without typechecking, so a green suite is not evidence `tsc` is
  happy; `test:e2e` runs against `dist/`, so `build` must precede it.
- **`bun run lint` does not exist in this repo.** Do not invoke or expect it.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`). The message
  explains *why*, not what. Only the final task's commit carries `!` and a `BREAKING CHANGE:` footer.
- **Never `git add -A` or `git add .`.** `docs/superpowers/` is untracked and the human has asked
  that the spec **not be committed**. Every commit below lists its files explicitly; add exactly
  those.
- **`exactOptionalPropertyTypes: true`** — optional fields are omitted via conditional spread, never
  set to `undefined`. Also `strict`, `noUncheckedIndexedAccess`, `isolatedModules`, `NodeNext`.
- **Named exports only; `.js` extensions on relative imports; `export *` is banned** in
  `src/index.ts`, `src/markdown.ts`, `src/google.ts` and the new `src/testing/index.ts`.
- **`#private` class fields, `readonly` / `Readonly<{...}>` types.**
- **Comments explain *why* and name the failure they prevent.** Never restate the code.
- **No live network in any test.** Every network-touching path takes its transport as an injectable
  parameter.
- **Scope stays `https://www.googleapis.com/auth/drive.file`.** No task introduces a second
  `googleapis.com/auth/` string anywhere under `src/` or `bin/`.
- **`bin/shorthand-notes.ts` is internal to this package** and may deep-import `../src/...js`. Keep
  every diff to it scoped to the lines the task names — no reformatting, no reordering.
- **Where the work happens — read this before running anything.** The branch
  `feat/core-sheds-consent` **already exists** and is already checked out in a worktree at
  **`D:\tools\shorthand-core\.worktrees\core-sheds-consent`**. Every executor works there, using that
  absolute path. Do **not** work in `D:\tools\shorthand-core` — that checkout is on `main` and must
  not be committed to, and do not cut a new branch.
  `bun install` has already been run in the worktree and the baseline is green, verified before Task 1:
  `bun test` reports **342 pass / 1 todo / 0 fail across 24 files**, and `bun run typecheck`,
  `bun run build` and `bun run test:e2e` all pass. Those numbers are here so you can tell a
  pre-existing condition from one you caused: if the gate is red *before* you change anything, stop
  and report rather than fixing it inside a task.

**The credentials file shape this plan converges on** (verified against
`node_modules/google-auth-library/build/src/auth/refreshclient.js` `fromJSON` L94–116 and
`.../auth/credentials.d.ts` `JWTInput` L53–64 in this pass):

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

`type`, `client_id`, `client_secret`, `refresh_token` are required by Google's own loader (it throws
by name on each) and are the only fields a read validates. `document_id` and `folder_id` are **both
optional** — see "Questions for the human" item 2, decided by the human. Serialization is
2-space-indented JSON with a trailing newline, keys in exactly that order, with an absent optional
field **omitted** rather than written as `null` (the same rule `exactOptionalPropertyTypes` already
imposes on the types). There is **no `tab_id`**.

---

## File map

| File | Fate |
| --- | --- |
| `src/google/oauth.ts` | **Deleted** (Task 4) |
| `src/google/container-doc.ts` | **Deleted** (Task 5) |
| `test/google-oauth.test.ts` | **Deleted** (Task 4) |
| `test/google-container-doc.test.ts` | **Deleted** (Task 5) |
| `bin/shorthand-notes.ts` | Modified — `google-login` and its three helpers removed (Task 3) |
| `test/cli.test.ts` | Modified — four tests deleted, two retargeted (Task 2) |
| `src/google.ts` | Modified — three re-exports removed, one added (Tasks 5, 6) |
| `src/google/file-token-provider.ts` | Rewritten — reader only (Tasks 6, 7) |
| `test/google-file-token-provider.test.ts` | Rewritten (Tasks 6, 7) |
| `test/google-scope-guard.test.ts` | Modified — positive assertion added (Task 1) |
| `src/testing/google-credentials-conformance.ts` | **New** (Task 8) |
| `src/testing/index.ts` | **New** barrel (Task 8) |
| `test/google-credentials-conformance.test.ts` | **New** (Tasks 8, 9) |
| `test/fixtures/credentials-writer.ts` | **New**, test-only correct writer (Task 8) |
| `test/fixtures/print-google-env.mjs` | **New**, env probe (Task 2) |
| `package.json` | Modified — `exports./testing` retargeted (Task 8), `version` (Task 10) |
| `docs/CONTRACT.md` | Modified (Task 10) |
| `.gitignore` | Modified — line 3's `google-login` reference (Task 10) |

**Why the order is what it is.** Every step of the deletion chain would break `bun run typecheck` if
taken out of order: `src/google.ts:24-25` re-exports `container-doc.ts`, so the module cannot be
deleted before its re-export (Task 5 does both in one commit); `bin/shorthand-notes.ts:496,518`
dynamically imports both doomed modules, so the CLI command goes first (Task 3); and
`test/cli.test.ts` asserts on `google-login`'s error text, so the tests are dealt with before the
command that produces it (Task 2). Tasks 1 and 2 are independent of the chain and go first because
they are small and reviewable on their own.

---

### Task 1: Give the scope guard a positive assertion

**Files:**
- Modify: `test/google-scope-guard.test.ts`

**Interfaces:**
- Produces: nothing importable. A second test case in the existing `describe` block.
- Consumes: nothing.

**Context:** `test/google-scope-guard.test.ts` walks `src/` and `bin/` for `.ts` files, matches
`/googleapis\.com\/auth\/[\w.]+/g`, and fails on any match that is not `drive.file`. **Verified in
this pass: it also passes on zero matches** — `expect(offenders).toEqual([])` is satisfied by an
empty file list just as well as by a correctly-scoped one. It cannot distinguish "correctly scoped"
from "the scope code left the building."

Exactly one match exists today: `GOOGLE_DOCS_SCOPE` at `src/google/docs-sink.ts:7`
(`export const GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/drive.file";`). That constant
survives this whole plan — the sink is what the scope describes and what fails at runtime if the
grant is wrong. What core loses by the end of this plan is narrower and worth stating exactly: core
no longer *requests* the scope, because the authorization URL is built elsewhere. So the guard now
protects against a scope constant creeping into core, and no longer protects against the request
widening. A guard that passes on an empty result set is not a guard.

This task is first because it is independent of the deletion chain and because the later tasks delete
a lot of Google code — the positive assertion is what will notice if they delete too much.

- [ ] **Step 1: Write the failing test**

Add this test to `test/google-scope-guard.test.ts`, inside the existing
`describe("Google OAuth scope guard", ...)` block, after the existing test:

```ts
  test("the drive.file scope is still actually present, anchored on the sink that uses it", async () => {
    // The negative test above is satisfied by an empty match set, so on its own it
    // cannot tell "correctly scoped" from "the scope code left the building". Core no
    // longer REQUESTS this scope — whatever performs consent builds the authorization
    // URL — so the only thing anchoring this guard to reality is the constant the sink
    // authenticates with. Anchor on that file by name: a match found anywhere else is
    // not evidence the sink still declares its scope.
    const anchor = join("src", "google", "docs-sink.ts");
    const anchored = (await readFile(anchor, "utf8")).match(/googleapis\.com\/auth\/[\w.]+/g) ?? [];
    expect(anchored).toEqual(["googleapis.com/auth/drive.file"]);

    const files = [...await allSourceFiles("src"), ...await allSourceFiles("bin")];
    const all = (await Promise.all(files.map(async (file) => (
      (await readFile(file, "utf8")).match(/googleapis\.com\/auth\/[\w.]+/g) ?? []
    )))).flat();
    expect(all.length).toBeGreaterThan(0);
  });
```

The file already imports `readFile` from `node:fs/promises` and `join` from `node:path`, and already
defines `allSourceFiles`. Do not re-import or redefine either.

- [ ] **Step 2: Verify the new test passes, then verify it is real by mutation**

Run: `bun test test/google-scope-guard.test.ts`
Expected: PASS (both tests). The new test passes against current code — that is correct; it pins a
property going forward rather than fixing a present bug.

Now prove it is not vacuous. Temporarily edit `src/google/docs-sink.ts:7`, replacing the scope string
with `"REMOVED"`:

Run: `bun test test/google-scope-guard.test.ts`
Expected: the **new** test FAILS (`expected [] to equal ["googleapis.com/auth/drive.file"]`) and the
**old** test still PASSES — which is the whole point of adding the new one.

Now revert that edit with `git checkout -- src/google/docs-sink.ts` and confirm both tests pass
again.

- [ ] **Step 3: Verify the negative half still bites**

Temporarily add this line at the end of `src/google/docs-sink.ts`:

```ts
const UNUSED_SECOND_SCOPE = "https://www.googleapis.com/auth/drive";
```

Run: `bun test test/google-scope-guard.test.ts`
Expected: **BOTH tests FAIL, and both failures are correct.** The old test fails with an offender
entry naming `src/google/docs-sink.ts` and `googleapis.com/auth/drive` — that is the one this step is
checking. The new test also fails, because its `anchored` match set is now the two-element array
`["googleapis.com/auth/drive.file", "googleapis.com/auth/drive"]`, which is the anchor doing its job:
a second scope in the anchored file is not the single declaration it pins. Do **not** "fix" the new
test to tolerate it. Revert with `git checkout -- src/google/docs-sink.ts` and confirm both are green
again.

- [ ] **Step 4: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS.

- [ ] **Step 5: Commit**

```bash
git add test/google-scope-guard.test.ts
git commit -m "test: make the scope guard fail when the scope disappears, not just when it widens"
```

---

### Task 2: Keep the two harness-leak regression tests, delete the four `google-login` argument tests

**Files:**
- Modify: `test/cli.test.ts` (current `google-login` block: lines 238–316)
- Create: `test/fixtures/print-google-env.mjs`

**Interfaces:**
- Produces: `test/fixtures/print-google-env.mjs`, a probe script that prints the two Google OAuth env
  variables it received as JSON on stdout. Used only by `test/cli.test.ts`.
- Consumes: the existing `run()` and `withoutGoogleOAuthEnv()` helpers in `test/cli.test.ts`
  (lines 319–356). Neither is modified.

**Context:** `test/cli.test.ts` currently has six tests that invoke `google-login` (verified: lines
241–311). Four are ordinary argument-validation tests for a command that ceases to exist in Task 3 —
they are deleted. Two are not:

- **Lines 269–290**, *"run() strips GOOGLE_OAUTH_CLIENT_ID/SECRET from any env it's given"*. Its own
  comment records that it exists because every other test in the file held the property only by
  caller discipline, and that a real incident — a test spawning a browser with real credentials —
  prompted it.
- **Lines 292–311**, *"--no-env-file prevents .env file leaks to subprocesses"*. Same family: it
  proves the spawn helper does not inherit a developer's real `.env` into a subprocess.

Both are harness-leak regression tests wearing a `google-login` costume; the command is merely a
fast-failing probe. Deleting all six would orphan `stripGoogleOAuthEnv` / `withoutGoogleOAuthEnv`
(lines 319–330) and remove the only proof that `run()`'s unconditional strip still happens. That
strip is at `test/cli.test.ts:344`. Retiring them would need the reason "the incident is no longer
reachable" — which is **false**: `run()` is still there, `process.env` is still its default, and a
future test can still spawn with real credentials.

**The retarget weakens both tests, and that must be recorded in their own comments.** They worked
because `google-login` failed fast on a missing credential, so a leak showed up as the command *not*
failing — i.e. as a browser opening. No surviving command has that shape. The replacement proves the
two keys never reach the child process; it does not prove a consent flow cannot start. See
"Questions for the human" item 8 for how this differs from the spec's literal suggestion.

This task comes **before** Task 3 because **all six** of these tests assert on `google-login`'s own
usage error text — `expect(result.stderr).toContain("google-login requires --client-id/--client-secret")`,
verified in every one of the six. Deleting the command first would leave the suite red between
commits.

- [ ] **Step 1: Create the probe fixture**

Create `test/fixtures/print-google-env.mjs`:

```js
#!/usr/bin/env node

// Reports which Google OAuth environment variables actually reached a child process.
//
// It exists because test/cli.test.ts's run() helper strips GOOGLE_OAUTH_CLIENT_ID and
// GOOGLE_OAUTH_CLIENT_SECRET from whatever env it is handed, and that strip is otherwise
// unobservable from the parent: spawn() takes the env and nothing gives it back. The two
// regression tests that guard the strip used to observe it indirectly, through a
// `google-login` command that failed fast without credentials; that command no longer
// exists, so the observation has to be direct.
process.stdout.write(JSON.stringify({
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID ?? null,
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? null,
}));
```

- [ ] **Step 2: Replace the whole `google-login` block in `test/cli.test.ts`**

Delete everything from the comment at line 238 (`// google-login performs a real loopback...`) through
line 316 (the closing comment `// must not trigger or wait on.`) inclusive — that is the four
argument tests, both harness-leak tests, and the two explanatory comments — and put this in its
place, still inside the `describe("shorthand-notes CLI", ...)` block:

```ts
  test("run() strips GOOGLE_OAUTH_CLIENT_ID/SECRET from any env it's given", async () => {
    // Retargeted, and deliberately weaker than the version it replaces. The original
    // probed `google-login`, which failed fast without a credential, so a leak showed up
    // as the command NOT failing — that is, as a browser opening. `google-login` was
    // deleted when core stopped performing consent, and no surviving command has that
    // shape, so this asserts the property directly instead: the two keys are absent from
    // the env run() hands to spawn. It proves the strip happens; it no longer proves that
    // nothing can open a consent window.
    //
    // Why the strip is load-bearing at all, kept from the original: run()'s default `env`
    // parameter is process.env, which (via Bun's dotenv auto-load of a real local .env)
    // can carry real Google OAuth credentials. A real incident — a test spawning a browser
    // with them — is what prompted the unconditional strip at run()'s spawn site. Every
    // other caller in this file also called withoutGoogleOAuthEnv(), so the property held
    // only by caller discipline. This test deliberately does NOT call it.
    const probe = join(process.cwd(), "test", "fixtures", "print-google-env.mjs");
    const result = await run(probe, [], {
      ...process.env,
      GOOGLE_OAUTH_CLIENT_ID: "leaked-via-inherited-env",
      GOOGLE_OAUTH_CLIENT_SECRET: "leaked-via-inherited-env",
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: null,
      GOOGLE_OAUTH_CLIENT_SECRET: null,
    });
  });

  test("--no-env-file prevents .env file leaks to subprocesses", async () => {
    // Same retarget, same weakening, same reason as the test above. This half proves the
    // other door: even with a .env sitting in the child's working directory, run()'s
    // --no-env-file flag stops the runtime loading it, so withoutGoogleOAuthEnv()'s intent
    // survives into the subprocess.
    const scratchDir = await mkdtemp(join(tmpdir(), ".cli-env-isolation-test-"));
    scratchDirectories.push(scratchDir);
    await writeFile(
      join(scratchDir, ".env"),
      "GOOGLE_OAUTH_CLIENT_ID=fake-leaked-id\nGOOGLE_OAUTH_CLIENT_SECRET=fake-leaked-secret\n",
      "utf8",
    );
    const probe = join(process.cwd(), "test", "fixtures", "print-google-env.mjs");
    const result = await run(probe, [], withoutGoogleOAuthEnv(), scratchDir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: null,
      GOOGLE_OAUTH_CLIENT_SECRET: null,
    });
  });
```

Do not touch `stripGoogleOAuthEnv`, `withoutGoogleOAuthEnv`, or `run()` (lines 319–356). They keep
working exactly as written; `run()` already accepts an arbitrary `entry` path.

- [ ] **Step 3: Run the tests**

Run: `bun test test/cli.test.ts`
Expected: PASS. Both retargeted tests pass against the **current** code — the strip and
`--no-env-file` already work; what changed is only what observes them.

- [ ] **Step 4: Verify by mutation that both tests still bite**

Temporarily change `test/cli.test.ts`'s `run()` spawn options (line 344) from
`env: stripGoogleOAuthEnv(env)` to `env`.

Run: `bun test test/cli.test.ts`
Expected: the first test FAILS — the probe reports `"leaked-via-inherited-env"` for both keys.
Revert the edit.

Now temporarily remove `"--no-env-file"` from the spawn argument array (line 348).

Run: `bun test test/cli.test.ts`
Expected: the second test FAILS — the probe reports the values from the scratch `.env`. Revert.

If either mutation does **not** fail the corresponding test, stop: the test is not observing what it
claims to and the human needs to know before Task 3 removes the old probe for good.

- [ ] **Step 5: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS.

- [ ] **Step 6: Commit**

```bash
git add test/cli.test.ts test/fixtures/print-google-env.mjs
git commit -m "test: retarget the env-leak regressions off google-login before it is deleted"
```

---

### Task 3: Remove the `google-login` command from the CLI

**Files:**
- Modify: `bin/shorthand-notes.ts` (lines 39, 49–54, 91, 92, 485–579)

**Interfaces:**
- Produces: nothing new. `runCli`'s exported signature is unchanged.
- Consumes: nothing from earlier tasks. Task 2 must have landed first, or four tests go red.

**Context:** Five edit sites, all verified in this pass:

| Line | What goes |
| --- | --- |
| 39 | The last line inside `usage()`'s string: `\n  shorthand-notes google-login [--create] [--port <n>] [--client-id <id>] [--client-secret <secret>]` |
| 53 | The `KNOWN_FLAGS` line `"--client-id", "--client-secret", "--port", "--create",` (the `KNOWN_FLAGS` block runs 49–54) |
| 91 | `if (command === "google-login") return await runGoogleLogin(args, environment);` |
| 92 | The dispatch error string, which names `google-login` |
| 485–579 | `runGoogleLogin`, `describeContainerDocOutcome`, `openInBrowser` |

Line 92's string is the one the prior draft of the spec missed. It reads
`"Expected capture, enhance, init-note, read-block, set-sections, or google-login."` and must lose
its last option. **Correction, verified in this pass: no test asserts on it.** `grep -rn "Expected capture" test/`
returns nothing — the claim that tests assert on this string was inherited from the spec and is
false. The Task-2-before-Task-3 ordering is still right, for a different reason: all six current
`google-login` tests assert on `"google-login requires --client-id/--client-secret"`, the command's
own usage error, which vanishes with the command. The new test added in Step 1 below is the *first*
assertion on line 92's text, and it is added by this task.

After this task, `src/google/oauth.ts` and `src/google/container-doc.ts` have no importer under
`bin/` (their only ones were the dynamic imports at lines 496 and 518), which is what makes Tasks 4
and 5 safe. `src/google.ts:24-25` still re-exports `container-doc.ts`, so it is not yet deletable —
that is Task 5's job.

Keep the diff to these five sites. `bin/shorthand-notes.ts` is a ~600-line file upstream of nothing;
do not reformat, reorder imports, or tidy anything you pass on the way.

- [ ] **Step 1: Write the failing test**

Add to `test/cli.test.ts`, inside the `describe("shorthand-notes CLI", ...)` block, next to the
existing `"rejects a missing known-flag value..."` test:

```ts
  test("google-login is gone: it is an unknown command and the usage text does not offer it", async () => {
    // There is no --help flag — runCli dispatches on the first positional and falls
    // through to usage() for anything unrecognised — so an unknown command IS the way to
    // read the usage text. Asserting on the text as well as the exit code is what catches
    // a half-deletion that removes the dispatch arm but leaves the advertisement.
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const result = await run(entry, ["google-login"], withoutGoogleOAuthEnv());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Expected capture, enhance, init-note, read-block, or set-sections.");
    expect(result.stderr).not.toContain("google-login");
    expect(result.stderr).not.toContain("--client-id");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/cli.test.ts`
Expected: FAIL. `google-login` is still dispatched, so it does not reach `usage()` at all — the run
will either error out on the missing client id (exit 2, but with the wrong stderr) or hang. If it
hangs, that is itself the confirmation the command still exists; kill it and proceed.

- [ ] **Step 3: Implement the five deletions**

1. In `usage()` at line 39, delete the trailing
   `\n  shorthand-notes google-login [--create] [--port <n>] [--client-id <id>] [--client-secret <secret>]`
   from the end of the string, so the string now ends after the `set-sections` line.

2. In `KNOWN_FLAGS`, delete this entire line:

```ts
  "--client-id", "--client-secret", "--port", "--create",
```

leaving:

```ts
const KNOWN_FLAGS = new Set([
  "--note", "--vault", "--sidecar", "--shorthand", "--fake-stream", "--no-reconnect",
  "--title", "--json", "--expect-hash", "--force", "--enhance", "--transcript",
  "--tier", "--dry-run", "--agent-stub", "--claude",
]);
```

3. In `runCli`, delete the line
   `if (command === "google-login") return await runGoogleLogin(args, environment);`

4. Change the next line from:

```ts
    return usage("Expected capture, enhance, init-note, read-block, set-sections, or google-login.");
```

to:

```ts
    return usage("Expected capture, enhance, init-note, read-block, or set-sections.");
```

5. Delete the three functions `runGoogleLogin`, `describeContainerDocOutcome` and `openInBrowser` in
   their entirety — everything from `async function runGoogleLogin(` down to the closing brace of
   `openInBrowser`, i.e. the whole run of lines 485–579. The next surviving function is
   `pathsEqual`.

Nothing else in the file changes. In particular `runCapture`, `runEnhance`, `createEnhanceRunner`,
`initializeNote`, `readBlock`, `setSections`, `runFinalEnhancementWithRetries`, `pathsEqual`,
`localIsoTimestamp` and the entry-point guard at the bottom are untouched.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/cli.test.ts`
Expected: PASS, including the two retargeted env tests from Task 2 (they no longer depend on
`google-login` at all, which is exactly why Task 2 came first).

- [ ] **Step 5: Verify the boundary grep**

Run: `grep -rniE "google-login|runGoogleLogin|describeContainerDocOutcome|openInBrowser" bin/`
Expected: **no output.**

- [ ] **Step 6: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS. `build` matters specifically here: it re-bundles `bin/shorthand-notes.ts`
and would fail loudly on a dangling dynamic import.

- [ ] **Step 7: Commit**

```bash
git add bin/shorthand-notes.ts test/cli.test.ts
git commit -m "feat: drop the google-login command; obtaining a credential is not core's job"
```

---

### Task 4: Delete `src/google/oauth.ts`

**Files:**
- Delete: `src/google/oauth.ts`
- Delete: `test/google-oauth.test.ts`

**Interfaces:**
- Produces: nothing. Removes `generatePkceChallenge`, `buildAuthorizationUrl`, `listenForRedirect`,
  `exchangeCode`, `PkceChallenge`, `LoopbackResult`, `ExchangedTokens`.
- Consumes: Task 3 must have landed — until it does, `bin/shorthand-notes.ts:496` dynamically
  imports this module.

**Context:** This is the interactive consent round-trip in its entirety: PKCE challenge generation,
the authorization URL (including `trigger_onepick=true`), the loopback listener a human is expected
to complete in a browser, and the code exchange. It is on the consumer side of the boundary — "the
moment a design requires core to open a browser window, run a listener a human is expected to
interact with, or render a consent screen, the design has crossed out of core."

**This is a deletion, not a move.** The TypeScript here is a reference implementation, verified
working against real Google interactively; it is the source a Rust port reads from, and it does not
live on in core as dead code "in case".

Verified in this pass: `oauth.ts` is a genuine leaf. Nothing under `src/` imports it — `src/google.ts`
never re-exported it — and after Task 3 nothing under `bin/` does either. The only remaining importer
is its own test file, which goes with it.

`src/google/file-token-provider.ts` does **not** import `oauth.ts`: its refresher builds a
`google-auth-library` client and exchanges a refresh token, which is post-consent runtime work
against an identity that already granted access. That is the fact that makes this clean.

- [ ] **Step 1: Confirm there are no importers left**

Run: `grep -rn "google/oauth" src/ bin/ test/`
Expected: exactly one hit — `test/google-oauth.test.ts:4`. If `bin/` or `src/` appears, Task 3 was
not completed; stop and fix that first.

- [ ] **Step 2: Delete both files**

```bash
git rm src/google/oauth.ts test/google-oauth.test.ts
```

- [ ] **Step 3: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS. A failure here means an importer was missed — find it with
`grep -rn "generatePkceChallenge\|buildAuthorizationUrl\|listenForRedirect\|exchangeCode" src/ bin/ test/`
rather than restoring the file.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: delete the OAuth consent round-trip; core never renders a consent screen"
```

(`git rm` has already staged both deletions; no `git add` is needed.)

---

### Task 5: Delete `src/google/container-doc.ts` and its re-exports together

**Files:**
- Delete: `src/google/container-doc.ts`
- Delete: `test/google-container-doc.test.ts`
- Modify: `src/google.ts` (lines 24–25)

**Interfaces:**
- Produces: nothing. Removes `ensureContainerDoc` and `ContainerDocResult` from
  `shorthand-core/google`. **This is a breaking change to the published surface**, unlike Task 4.
- Consumes: Task 3 must have landed (it removed `bin/shorthand-notes.ts:518`'s dynamic import).

**Context:** `ensureContainerDoc` creates a Drive folder, creates the container Doc, and reparents it.
That is *obtaining a target*, which is a consumer concern under the same boundary rule as Task 4.

**Keep the module deletion and the re-export removal in one commit** — a preference, and the reason
is reviewability, not necessity. The plan previously claimed one commit was forced. It is not, and the
correction matters because a false "must" invites an executor to distrust the ones that are real:
removing the two re-export lines *first* leaves `container-doc.ts` orphaned but green (it imports only
`googleapis` and a type, and `test/google-container-doc.test.ts` imports the module directly rather
than through `src/google.ts`), so remove-then-delete is two green commits. Only the reverse order is
red. One commit is still better here, because the breaking change to the published surface and the
deletion that causes it belong in one reviewable unit. `src/google.ts:24-25` reads:

```ts
export { ensureContainerDoc } from "./google/container-doc.js";
export type { ContainerDocResult } from "./google/container-doc.js";
```

Deleting the module without those lines is a compile error. Verified in this pass, and worth stating
because an earlier draft of the spec wrongly called this module a leaf: it is not, and that is exactly
the difference between an internal deletion and a breaking change to the published surface.

- [ ] **Step 1: Delete the module and its test, and remove the re-exports**

```bash
git rm src/google/container-doc.ts test/google-container-doc.test.ts
```

Then in `src/google.ts`, delete these two lines (currently 24–25, the last two lines of the file):

```ts
export { ensureContainerDoc } from "./google/container-doc.js";
export type { ContainerDocResult } from "./google/container-doc.js";
```

Leave the rest of `src/google.ts` exactly as it is — including its header comment and the
`writeCredentials` re-export on line 21, which Task 6 handles.

- [ ] **Step 2: Confirm nothing references it**

Run: `grep -rn "container-doc\|ensureContainerDoc\|ContainerDocResult" src/ bin/ test/`
Expected: **no output.**

- [ ] **Step 3: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS.

- [ ] **Step 4: Commit**

```bash
git add src/google.ts
git commit -m "feat: delete ensureContainerDoc; obtaining a target is not core's job"
```

---

### Task 6: Retype the credentials file to the ADC superset and validate every read

**Files:**
- Modify: `src/google/file-token-provider.ts`
- Modify: `src/google.ts` (line 21)
- Modify: `test/google-file-token-provider.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GoogleCredentials = Readonly<{
    type: "authorized_user";
    client_id: string;
    client_secret: string;
    refresh_token: string;
    /** Optional: nothing in core reads it off this file. See Questions item 2. */
    document_id?: string;
    folder_id?: string;
  }>;

  export type CredentialsReadResult =
    | Readonly<{ ok: true; value: GoogleCredentials }>
    | Readonly<{ ok: false; message: string }>;

  export function credentialsPath(environment?: NodeJS.ProcessEnv): string;   // unchanged
  export async function readCredentials(path?: string): Promise<CredentialsReadResult>;
  ```
  Removes `writeCredentials` and `mergeCredentials` entirely.
- Consumed by: Task 7 (`FileTokenProvider`'s refresher), Task 8 (the conformance scenarios).

**Context:** Four changes in one commit, because they are one change:

1. **The field names become `snake_case` and match Google's ADC `authorized_user` format.** Verified
   against the installed source in this pass — `node_modules/google-auth-library/build/src/auth/refreshclient.js`
   `fromJSON` (L94–116) throws by name when `type !== "authorized_user"` or when `client_id`,
   `client_secret` or `refresh_token` is absent, and reads nothing else except the optional
   `quota_project_id` and `universe_domain`. There is no key allow-list and no throw on unknown
   properties anywhere on that path, which is what makes a superset file viable at all. Our two
   fields go in the same file rather than a sibling, because two files with the same owner and the
   same write moment means a torn state between them.
2. **`tabId` leaves the file.** It is not a credential — it identifies one meeting's tab, it changes
   every meeting, and it is a single optional string in a single global file, so two concurrent
   captures could never both be represented. It was not merely misplaced; it could not have worked.
   Where it goes instead is the enhance/capture wiring spec's decision, not this plan's.
3. **`writeCredentials` and `mergeCredentials` are deleted.** One writer per file: a file with two
   writers in two languages has an invariant that lives in neither of them. `mergeCredentials` exists
   solely to preserve a `tabId` its own caller can never set; with `tabId` gone and one writer left
   there is nothing to merge, and the wholesale overwrite is the correct semantic. This also makes a
   known deferred bug unrepresentable — a re-login used to leave a stale `folder_id` behind because
   the merge fell back to the existing value.
4. **`readCredentials` validates and never throws.** Today it is a bare `JSON.parse` plus a type
   assertion. That was tolerable while core wrote the file. It is not tolerable when the writer is a
   different program in a different language: a malformed file currently throws out of
   `getAccessToken()` instead of returning a `TokenResult` error, which crashes a capture instead of
   reporting "not authorized".

**A read validates only what a token needs: `type`, `client_id`, `client_secret`, `refresh_token`.**
`document_id` is optional, decided by the human — see "Questions for the human" item 2 for the
reasoning and for the two target-selection flows this keeps open. Nothing in core reads `document_id`
off this file (`GoogleDocsNoteSink` takes `documentId` as a constructor option,
`src/google/docs-sink.ts:9-14`), so requiring it would make the file unreadable when absent for the
benefit of no consumer. Absent, it is **omitted** from the read result rather than set to `undefined`,
matching `folder_id` and `exactOptionalPropertyTypes`.

The two user-facing strings at lines 73 and 89 are fixed here too. They tell the user to run
`shorthand-notes google-login`, which no longer exists, and **nothing fails when they are wrong** —
they are the change most likely to survive by accident. The replacements must not name whatever
performs consent: core cannot know about it. Keep the path, which is genuinely useful and is core's
own.

**Every existing `google-credentials.json` becomes unusable** regardless of this rename, because a
refresh token is bound to the OAuth client that issued it and consent will be re-performed by a
different client. There is no migration and none is wanted.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `test/google-file-token-provider.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileTokenProvider, readCredentials } from "../src/google/file-token-provider.js";
import type { GoogleCredentials } from "../src/google/file-token-provider.js";

const VALID: GoogleCredentials = {
  type: "authorized_user",
  client_id: "1234567890-test.apps.googleusercontent.com",
  client_secret: "test-client-secret",
  refresh_token: "rt-1",
  document_id: "doc-1",
};

async function scratchPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "google-token-"));
  return join(directory, "google-credentials.json");
}

/** Test-only writer. Core is a pure reader; nothing under src/ writes this file. */
async function writeRaw(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o600);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  return writeRaw(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("readCredentials", () => {
  test("reads back every field of a well-formed file", async () => {
    const path = await writeJson(await scratchPath(), { ...VALID, folder_id: "folder-1" });
    expect(await readCredentials(path)).toEqual({
      ok: true,
      value: { ...VALID, folder_id: "folder-1" },
    });
    await rm(path, { force: true });
  });

  test("omits folder_id entirely when the file has none", async () => {
    const result = await readCredentials(await writeJson(await scratchPath(), VALID));
    expect(result.ok).toBe(true);
    if (result.ok) expect("folder_id" in result.value).toBe(false);
  });

  test("a credential with no document_id reads successfully, with the key omitted", async () => {
    // Decided by the human: a missing target does not make a credential unreadable.
    // Nothing in core reads document_id off this file — GoogleDocsNoteSink takes
    // documentId as a constructor option — so rejecting the file would serve no consumer,
    // and it would foreclose a "connect now, choose the target next" step in whatever
    // performs consent.
    const partial: Record<string, unknown> = { ...VALID };
    delete partial.document_id;
    const result = await readCredentials(await writeJson(await scratchPath(), partial));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("document_id" in result.value).toBe(false);
      expect(result.value.refresh_token).toBe("rt-1");
    }
  });

  test("ignores unknown top-level keys instead of rejecting them", async () => {
    // Forward compatibility: a newer writer adding a field must not break an older core.
    const path = await writeJson(await scratchPath(), { ...VALID, quota_project_id: "p", future_field: 7 });
    expect(await readCredentials(path)).toEqual({ ok: true, value: VALID });
  });

  test("reports an absent file without throwing", async () => {
    const result = await readCredentials(await scratchPath());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("No Google credentials at");
  });

  test("reports non-JSON bytes without throwing", async () => {
    const result = await readCredentials(await writeRaw(await scratchPath(), "not json at all"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not valid JSON");
  });

  test("reports a JSON value that is not an object without throwing", async () => {
    const result = await readCredentials(await writeRaw(await scratchPath(), "[1,2,3]"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not a JSON object");
  });

  test("rejects a wrong type discriminator by name", async () => {
    const path = await writeJson(await scratchPath(), { ...VALID, type: "service_account" });
    const result = await readCredentials(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("authorized_user");
  });

  test.each(["client_id", "client_secret", "refresh_token"] as const)(
    "names the missing required ADC field %s",
    async (field) => {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[field];
      const result = await readCredentials(await writeJson(await scratchPath(), partial));
      expect(result.ok).toBe(false);
      // The QUOTED field name, not the bare word. `type` is deliberately not in this sweep:
      // deleting it takes the discriminator branch, whose message reads `…have type
      // undefined; expected "authorized_user".` — which satisfies a bare toContain("type")
      // through the words "have type" while naming no missing field at all. An assertion
      // that passes for the wrong reason is exactly what this task exists to prevent.
      if (!result.ok) expect(result.message).toContain(`"${field}"`);
    },
  );

  test("a missing type is reported as a wrong discriminator, naming both what it found and what it wanted", async () => {
    const partial: Record<string, unknown> = { ...VALID };
    delete partial.type;
    const result = await readCredentials(await writeJson(await scratchPath(), partial));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("have type undefined");
      expect(result.message).toContain('expected "authorized_user"');
    }
  });
});

describe("FileTokenProvider.getAccessToken", () => {
  test("returns not-authorized, not a throw, when no credentials file exists yet", async () => {
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: await scratchPath(),
    });
    expect(await provider.getAccessToken()).toEqual({
      ok: false, error: { code: "not-authorized", message: expect.any(String) },
    });
  });

  test("returns not-authorized, not a throw, for a malformed file", async () => {
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s",
      credentialsPath: await writeRaw(await scratchPath(), "{ broken"),
    });
    expect(await provider.getAccessToken()).toEqual({
      ok: false, error: { code: "not-authorized", message: expect.any(String) },
    });
  });

  test("exchanges the stored refresh token for an access token", async () => {
    const path = await writeJson(await scratchPath(), VALID);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      // Test seam: injected refresher, not a live client. No live network in any test.
      refreshAccessToken: async (refreshToken: string) => {
        expect(refreshToken).toBe("rt-1");
        return { ok: true, token: "access-token-1" };
      },
    });
    expect(await provider.getAccessToken()).toEqual({ ok: true, token: "access-token-1" });
  });

  test("maps invalid_grant to revoked", async () => {
    const path = await writeJson(await scratchPath(), VALID);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      refreshAccessToken: async () => { throw Object.assign(new Error("invalid_grant"), { code: "invalid_grant" }); },
    });
    expect(await provider.getAccessToken()).toEqual({
      ok: false, error: { code: "revoked", message: expect.any(String) },
    });
  });

  test("maps a network failure to transport", async () => {
    const path = await writeJson(await scratchPath(), VALID);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      refreshAccessToken: async () => { throw new Error("ENOTFOUND"); },
    });
    expect(await provider.getAccessToken()).toEqual({
      ok: false, error: { code: "transport", message: expect.any(String) },
    });
  });

  test("no user-facing message names a command that no longer exists", async () => {
    // These two strings compile fine while being wrong, so nothing else catches them.
    // BOTH are rewritten by this task, so both are asserted here. Covering only the
    // missing-file path is how the `revoked` message survives the change by accident —
    // the same "compiles fine while being wrong" failure this test exists to catch.
    const missing = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: await scratchPath(),
    });
    const missingResult = await missing.getAccessToken();
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.error.message).not.toContain("google-login");

    const revoked = new FileTokenProvider({
      clientId: "c", clientSecret: "s",
      credentialsPath: await writeJson(await scratchPath(), VALID),
      refreshAccessToken: async () => { throw Object.assign(new Error("invalid_grant"), { code: "invalid_grant" }); },
    });
    const revokedResult = await revoked.getAccessToken();
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) {
      expect(revokedResult.error.code).toBe("revoked");
      expect(revokedResult.error.message).not.toContain("google-login");
      expect(revokedResult.error.message).toContain("reconnect");
    }
  });
});
```

Note: `defaultRefresher`'s caching test is **deliberately absent from this task** — it is rewritten in
Task 7 when the refresher's signature changes. Do not try to keep the old one working here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/google-file-token-provider.test.ts`
Expected: FAIL — the file no longer imports `writeCredentials`/`mergeCredentials` (which still exist)
and `GoogleCredentials` still has `refreshToken`/`documentId`, so the `VALID` literal will not
typecheck and `readCredentials` returns the wrong shape.

- [ ] **Step 3: Implement — rewrite the top half of `src/google/file-token-provider.ts`**

Replace everything from the top of the file down to and including the closing brace of
`mergeCredentials` (currently lines 1–51) with:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { shorthandConfigDirectory } from "../config.js";
import { tokenError, type TokenProvider, type TokenResult } from "../auth/token-provider.js";

/**
 * The credentials file as core READS it: Google's Application Default Credentials
 * `authorized_user` shape, plus the two fields that name our target.
 *
 * Core does not write this file, and there is no function here that does. One writer
 * per file — a file with two writers in two languages has an invariant that lives in
 * neither of them, and the merge such a scheme needs is exactly the class of silent
 * data loss removing the second writer removes. `src/testing/google-credentials-conformance.ts`
 * is the executable form of the contract a writer must satisfy.
 *
 * The four ADC field names are Google's, not ours: `UserRefreshClient.fromJSON` reads
 * them by those names and throws by name when one is absent. `document_id`/`folder_id`
 * are ours and are in the same file rather than a sibling, because two files with one
 * owner and one write moment means a torn state between them.
 *
 * Only the four ADC fields are required. `document_id` is optional because nothing in
 * core reads it from here — GoogleDocsNoteSink takes documentId as a constructor option —
 * so requiring it would make the file unreadable when absent for no consumer's benefit,
 * and would force whoever performs consent to obtain a target in the same step.
 */
export type GoogleCredentials = Readonly<{
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  document_id?: string;
  folder_id?: string;
}>;

export type CredentialsReadResult =
  | Readonly<{ ok: true; value: GoogleCredentials }>
  | Readonly<{ ok: false; message: string }>;

export function credentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(shorthandConfigDirectory(environment), "google-credentials.json");
}

const REQUIRED_ADC_FIELDS = ["client_id", "client_secret", "refresh_token"] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Reads and validates the credentials file. NEVER throws.
 *
 * The writer is a different program in a different language, so a malformed or partial
 * file is ordinary input rather than a bug in core. It has to arrive at the caller as a
 * reportable "not authorized" — an exception here surfaces mid-capture as a crash
 * instead of as a message telling the user what to do.
 */
export async function readCredentials(path = credentialsPath()): Promise<CredentialsReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, message: `No Google credentials at ${path}; connect your Google account, then retry.` };
    }
    return { ok: false, message: `Google credentials at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: `Google credentials at ${path} are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: `Google credentials at ${path} are not a JSON object.` };
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "authorized_user") {
    return { ok: false, message: `Google credentials at ${path} have type ${JSON.stringify(record.type)}; expected "authorized_user".` };
  }
  for (const field of REQUIRED_ADC_FIELDS) {
    if (!nonEmptyString(record[field])) {
      return { ok: false, message: `Google credentials at ${path} are missing the required field "${field}"; connect your Google account, then retry.` };
    }
  }
  // document_id is NOT validated. A missing target does not make a token unobtainable,
  // and nothing in core reads document_id from this file, so rejecting the file here
  // would only make a perfectly usable credential unreadable. It is carried through when
  // present and omitted when not, exactly like folder_id.
  const documentId = record.document_id;
  const folderId = record.folder_id;
  return {
    ok: true,
    // Unknown top-level keys are dropped rather than rejected: a newer writer adding a
    // field it needs must not break an older core that has never heard of it.
    value: {
      type: "authorized_user",
      client_id: record.client_id as string,
      client_secret: record.client_secret as string,
      refresh_token: record.refresh_token as string,
      ...(nonEmptyString(documentId) ? { document_id: documentId } : {}),
      ...(nonEmptyString(folderId) ? { folder_id: folderId } : {}),
    },
  };
}
```

Then, further down the same file, change `getAccessToken`'s body from:

```ts
    const credentials = await readCredentials(this.#path);
    if (credentials === undefined) {
      return { ok: false, error: tokenError("not-authorized", `No Google credentials at ${this.#path}; run \`shorthand-notes google-login\` first.`) };
    }
```

to:

```ts
    const credentials = await readCredentials(this.#path);
    if (!credentials.ok) return { ok: false, error: tokenError("not-authorized", credentials.message) };
```

and change the one remaining line that reads the token, from
`return await this.#refresh(credentials.refreshToken);` to
`return await this.#refresh(credentials.value.refresh_token);`.

Finally change the revoked message from
`"Google revoked this credential; run google-login again"` to
`"Google revoked this credential; reconnect your Google account, then retry."`

Leave `FileTokenProviderOptions`, the `FileTokenProvider` constructor and `defaultRefresher` alone —
Task 7 owns those. The `import { chmod, mkdir, writeFile }` names are gone with `writeCredentials`;
the import line above already reflects that.

- [ ] **Step 4: Remove the `writeCredentials` re-export**

In `src/google.ts`, change line 21 from:

```ts
export { FileTokenProvider, credentialsPath, readCredentials, writeCredentials } from "./google/file-token-provider.js";
```

to:

```ts
export { FileTokenProvider, credentialsPath, readCredentials } from "./google/file-token-provider.js";
```

and change line 22 from:

```ts
export type { FileTokenProviderOptions, GoogleCredentials } from "./google/file-token-provider.js";
```

to:

```ts
export type { CredentialsReadResult, FileTokenProviderOptions, GoogleCredentials } from "./google/file-token-provider.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/google-file-token-provider.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Verify the writer is gone**

Run: `grep -n "mergeCredentials\|writeCredentials\|tabId" src/google/file-token-provider.ts`
Expected: **no output.**

> **WARNING — do not widen this grep to `src/`, and do not delete `tabId` anywhere else.** `tabId` is
> the **Google Docs API's own field name** and is legitimate throughout `src/google/`: ~21 hits across
> `src/google/docs-sink.ts` (13, including `GoogleDocsNoteSinkOptions.tabId` at L11 and the private
> `#tabId` at L29), `src/google/docs-client.ts` (L10, L146) and `src/google/requests.ts` (10,
> including the `buildWriteRequests` guard at L82 that throws when a Docs request is built without
> one). They are pinned by `test/google-requests.test.ts` and `test/google-docs-sink*.test.ts`, and
> removing them breaks the working Docs sink. What this task removes is the `tabId` *slot in the
> credentials file*, which lives only in `src/google/file-token-provider.ts` — which is why the grep
> is scoped to that one file, as the spec's own verification item 11 words it ("returns nothing under
> `src/google/file-token-provider.ts`").

- [ ] **Step 7: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS.

- [ ] **Step 8: Commit**

```bash
git add src/google/file-token-provider.ts src/google.ts test/google-file-token-provider.test.ts
git commit -m "feat: read an ADC authorized_user credentials file and stop writing one"
```

---

### Task 7: Source `client_id`/`client_secret` from the file, via Google's own loader

**Files:**
- Modify: `src/google/file-token-provider.ts` (`FileTokenProviderOptions`, the constructor,
  `defaultRefresher`)
- Modify: `test/google-file-token-provider.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FileTokenProviderOptions = Readonly<{
    credentialsPath?: string;
    /** Test seam only; production always refreshes via google-auth-library's UserRefreshClient. */
    refreshAccessToken?: (credentials: GoogleCredentials) => Promise<TokenResult>;
  }>;

  export function defaultRefresher(
    createClient?: (credentials: GoogleCredentials) => RefreshableClient,
  ): (credentials: GoogleCredentials) => Promise<TokenResult>;
  ```
  `new FileTokenProvider()` with no arguments is now valid.
- Consumes: `GoogleCredentials` and `readCredentials` from Task 6.

**Context:** Today `clientId`/`clientSecret` are constructor arguments, deliberately kept out of the
file. That exclusion is reversed, and the reasons are worth having in the code:

- Compiled constants in core would embed the consent app's Google identity in core — the dependency
  running the wrong way, and an OAuth client that could only be rotated by releasing a new core.
- Environment variables would make core's correctness a function of *how it was launched*: a capture
  started from a terminal, from an app, from a scheduler and from a test would each behave
  differently with identical code and identical on-disk state.
- Independently of the dependency rule: **a refresh token is only meaningful paired with the client
  that issued it.** Storing them separately stores half a credential in each place. Google's own ADC
  format puts all three in one file, which is a good sign the standard path already worked this out.

The refresher now hands the parsed object to `google-auth-library`'s own loader rather than
reconstructing an `OAuth2Client` by hand. Verified in this pass against
`node_modules/google-auth-library/build/src/auth/refreshclient.js`:

- `static fromJSON(json)` at L152–156 constructs a `UserRefreshClient` and calls the instance
  `fromJSON`, which sets `_clientId`, `_clientSecret`, `_refreshToken` **and**
  `this.credentials.refresh_token` (L112). So no separate `setCredentials` call is needed.
- `class UserRefreshClient extends OAuth2Client` (L20) overrides only `refreshTokenNoCache` and
  `fetchIdToken`. `getAccessToken()` is inherited unmodified, so the caching analysis already
  recorded in this module's doc comment still applies: it refreshes only when
  `!credentials.access_token || isTokenExpiring()`.
- `UserRefreshClient.fromJSON` takes `JWTInput` (`credentials.d.ts` L53–64), whose fields are all
  optional strings, so `GoogleCredentials` is assignable directly — no cast, and the extra
  `document_id`/`folder_id` are not excess-property-checked because the argument is not an object
  literal.

**The single-client requirement is a regression guard, not a nicety.** Constructing a client per
`getAccessToken()` call re-breaks a cache that was already fixed once.

- [ ] **Step 1: Write the failing tests**

In `test/google-file-token-provider.test.ts`, change the import line to add `defaultRefresher`:

```ts
import { FileTokenProvider, defaultRefresher, readCredentials } from "../src/google/file-token-provider.js";
```

Then, in the five `FileTokenProvider.getAccessToken` tests written in Task 6, delete
`clientId: "c", clientSecret: "s",` from every options object, and change the one test that inspects
the refresher's argument so its seam takes the whole credential:

```ts
      refreshAccessToken: async (credentials: GoogleCredentials) => {
        expect(credentials.refresh_token).toBe("rt-1");
        expect(credentials.client_id).toBe("1234567890-test.apps.googleusercontent.com");
        expect(credentials.client_secret).toBe("test-client-secret");
        return { ok: true, token: "access-token-1" };
      },
```

Finally append this new `describe` block to the end of the file:

```ts
describe("defaultRefresher", () => {
  test("constructs the underlying client once, not once per call", async () => {
    // Regression guard for a fix that has already been made once. A client rebuilt per
    // call never has a cached access_token for the library's own isTokenExpiring() check
    // to short-circuit on, so every call pays a token-endpoint round-trip.
    let clientsCreated = 0;
    const refresher = defaultRefresher(() => {
      clientsCreated += 1;
      return { getAccessToken: async () => ({ token: "token-from-first-refresh" }) };
    });
    expect(await refresher(VALID)).toEqual({ ok: true, token: "token-from-first-refresh" });
    expect(await refresher(VALID)).toEqual({ ok: true, token: "token-from-first-refresh" });
    expect(clientsCreated).toBe(1);
  });

  test("builds the client from the credential's own client_id/client_secret", async () => {
    // The whole point of moving these into the file: a refresh token is only meaningful
    // paired with the client that issued it, so the client must come from the same file.
    let seen: GoogleCredentials | undefined;
    const refresher = defaultRefresher((credentials) => {
      seen = credentials;
      return { getAccessToken: async () => ({ token: "t" }) };
    });
    await refresher(VALID);
    expect(seen).toEqual(VALID);
  });

  test("maps a client that returns no token to transport", async () => {
    const refresher = defaultRefresher(() => ({ getAccessToken: async () => ({ token: null }) }));
    expect(await refresher(VALID)).toEqual({
      ok: false, error: { code: "transport", message: expect.any(String) },
    });
  });

  test("the real default really is google-auth-library's own loader", async () => {
    // Pins the standard path: if someone replaces fromJSON with hand-rolled field
    // plumbing again, an ADC file that Google accepts and we reject stops being caught.
    const { UserRefreshClient } = await import("google-auth-library");
    const client = UserRefreshClient.fromJSON(VALID);
    expect(client).toBeInstanceOf(UserRefreshClient);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/google-file-token-provider.test.ts`
Expected: FAIL — `defaultRefresher` still takes `(clientId, clientSecret, createClient?)`, so the
one-argument calls do not typecheck and the `FileTokenProvider` options objects are now missing
required `clientId`/`clientSecret`.

- [ ] **Step 3: Implement**

In `src/google/file-token-provider.ts`, change the import at the top from
`import { OAuth2Client } from "google-auth-library";` to
`import { UserRefreshClient } from "google-auth-library";`.

Replace `FileTokenProviderOptions` and the `FileTokenProvider` constructor with:

```ts
export type FileTokenProviderOptions = Readonly<{
  credentialsPath?: string;
  /** Test seam only; production always refreshes via google-auth-library's UserRefreshClient. */
  refreshAccessToken?: (credentials: GoogleCredentials) => Promise<TokenResult>;
}>;

export class FileTokenProvider implements TokenProvider {
  readonly #path: string;
  readonly #refresh: (credentials: GoogleCredentials) => Promise<TokenResult>;

  constructor(options: FileTokenProviderOptions = {}) {
    this.#path = options.credentialsPath ?? credentialsPath();
    this.#refresh = options.refreshAccessToken ?? defaultRefresher();
  }
```

Inside `getAccessToken`, change `return await this.#refresh(credentials.value.refresh_token);` to
`return await this.#refresh(credentials.value);`.

Replace `RefreshableClient` and `defaultRefresher` with:

```ts
type RefreshableClient = Pick<UserRefreshClient, "getAccessToken">;

/**
 * Hands the credential to google-auth-library's own ADC loader and holds ONE client
 * across calls.
 *
 * Verified against the installed source
 * (node_modules/google-auth-library/build/src/auth/refreshclient.js): the static
 * fromJSON builds a UserRefreshClient and sets credentials.refresh_token itself, so no
 * separate setCredentials call is needed; and UserRefreshClient extends OAuth2Client
 * overriding only refreshTokenNoCache and fetchIdToken, so getAccessToken() is inherited
 * unmodified and still refreshes only when `!credentials.access_token ||
 * isTokenExpiring()`. A client rebuilt per call therefore has nothing cached to check
 * and pays a full token-endpoint round-trip every time — the exact regression this
 * closure shape was introduced to fix.
 */
export function defaultRefresher(
  createClient: (credentials: GoogleCredentials) => RefreshableClient =
    (credentials) => UserRefreshClient.fromJSON(credentials),
): (credentials: GoogleCredentials) => Promise<TokenResult> {
  let client: RefreshableClient | undefined;
  return async (credentials: GoogleCredentials): Promise<TokenResult> => {
    client ??= createClient(credentials);
    const { token } = await client.getAccessToken();
    if (token === null || token === undefined) {
      return { ok: false, error: tokenError("transport", "Token refresh returned no access token") };
    }
    return { ok: true, token };
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/google-file-token-provider.test.ts && bun run typecheck`
Expected: PASS. If `UserRefreshClient.fromJSON(credentials)` does not typecheck, do **not** reach for
`as never` or `as unknown as JWTInput` — re-read `node_modules/google-auth-library/build/src/auth/credentials.d.ts`'s
`JWTInput` and report what actually differs, because an assignability failure there means the file
format and Google's loader have diverged, which is the one thing this whole design rests on.

- [ ] **Step 5: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS.

- [ ] **Step 6: Commit**

```bash
git add src/google/file-token-provider.ts test/google-file-token-provider.test.ts
git commit -m "feat: take the OAuth client from the credentials file, not from the caller"
```

---

### Task 8: Ship the credentials-file conformance fixture

**Files:**
- Create: `src/testing/google-credentials-conformance.ts`
- Create: `src/testing/index.ts`
- Create: `test/fixtures/credentials-writer.ts`
- Create: `test/google-credentials-conformance.test.ts`
- Modify: `package.json` (`exports["./testing"]`)

**Interfaces:**
- Produces, from `shorthand-core/testing`:
  ```ts
  export type CredentialsFixture = Readonly<{
    type: "authorized_user";
    client_id: string;
    client_secret: string;
    refresh_token: string;
    document_id?: string;   // optional, mirroring GoogleCredentials — see Questions item 2
    folder_id?: string;
  }>;
  export type CredentialsWriterHarness = Readonly<{
    write(credentials: CredentialsFixture): Promise<string>;
    dispose?(): Promise<void>;
  }>;
  export type CredentialsHarnessFactory = () => Promise<CredentialsWriterHarness>;
  export type CredentialsConformanceSupport = Readonly<{ posixPermissions?: boolean }>;
  export type CredentialsConformanceScenario = Readonly<{
    name: string;
    requires?: keyof CredentialsConformanceSupport;
    run(createHarness: CredentialsHarnessFactory): Promise<void>;
  }>;
  export type CredentialsGoldenFixture = Readonly<{ credentials: CredentialsFixture; bytes: string }>;
  export const GOOGLE_CREDENTIALS_FIXTURES: Readonly<{
    minimal: CredentialsGoldenFixture;
    withFolder: CredentialsGoldenFixture;
  }>;
  export const GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS: readonly CredentialsConformanceScenario[];
  export function describeGoogleCredentialsConformance(
    primitives: ConformanceTestPrimitives,
    name: string,
    createHarness: CredentialsHarnessFactory,
    support?: CredentialsConformanceSupport,
  ): void;
  ```
  Plus everything `sink-conformance.ts` already exports, re-exported through the new barrel.
- Consumes: `credentialsPath` and `readCredentials` from Task 6; `ConformanceTestPrimitives` from
  `src/testing/sink-conformance.ts:307-313`.

**Context:** Prose contracts drift. Core already solved this once for external sink implementers:
`src/testing/sink-conformance.ts` ships `NOTE_SINK_CONFORMANCE_SCENARIOS` and
`describeNoteSinkConformance` as **shipped API, not tests** — no test-runner import, no assertion
library, every scenario a plain async function that throws on failure. Read that file before writing
this one; this is its sibling and must follow it faithfully.

Two deliberate differences, both with reasons:

- **It also ships golden bytes** (`GOOGLE_CREDENTIALS_FIXTURES`). The sink suite does not need them
  because sink implementers are all TypeScript. The credentials writer is in another language, so a
  language-neutral artifact is worth having on its own — a unit test over there can compare bytes
  with no JavaScript involved at all. A byte-level assertion also catches a writer that is *nearly*
  right, which a structural one does not.
- **The two heavy runtime imports are deferred.** `./testing` becomes one barrel serving both suites,
  and a Markdown-sink implementer running the sink contract must not pick up `google-auth-library` or
  core's own Google module for it. So `google-auth-library` and `../google/file-token-provider.js` are
  `await import(...)`ed inside the scenarios that use them. `node:fs/promises` and `node:path` stay
  static — they are Node built-ins, already resolved in any process running this suite, and deferring
  them would buy nothing. Type-only imports are erased and are fine statically. Say exactly that in
  the module's doc comment; a blanket "everything is dynamic" would be false the moment anyone reads
  the import block.

The cross-language seam is `write()`, deliberately: the harness is where the language-specific part
goes, exactly as `SinkHarness` already does for transport-specific parts, and the scenarios never
know about it.

`shorthand-core/testing` currently resolves to a single module. Turning it into a barrel is an
**additive** change to that entry point, not a breaking one — `CONTRACT.md` §1 describes it as "the
executable contract", singular, and splitting subpaths would widen the `exports` map for no reader
benefit. **Two existing test files import that specifier and both go through the new barrel:**
`test/markdown-sink.test.ts:9` and `test/google-docs-sink.test.ts:2`. The reviewer applied this
`exports` change in the worktree and confirmed both still pass, then reverted; check both, not just
the Markdown one.

**This task has no red phase of its own, and that is deliberate: Task 9 IS Task 8's red phase.**
Steps 1–4 build the scenarios and Step 5 expects them green against a correct writer, which on its own
is not evidence that any scenario can fail — the exact objection this plan raises about conformance
suites elsewhere. Task 9's six wrong writers are what supply it. **The two commits must therefore land
together**: do not stop the session, hand off, or push between them, and if Task 9 shows a scenario
that cannot fail, the fix belongs in Task 8's scenario rather than in Task 9's expectation. They are
kept as two commits only because the shipped module and the test that proves it bites are separately
reviewable.

- [ ] **Step 1: Create the barrel and repoint `package.json`**

Create `src/testing/index.ts`:

```ts
/**
 * The executable contracts core publishes: the `NoteSink` port, and the credentials
 * file core reads but does not write.
 *
 * One specifier serves both because `shorthand-core/testing` is described as the
 * executable contract, singular, and a second subpath would widen the exports map for
 * no reader benefit. The cost that buys is that a sink implementer resolves this file
 * too — which is why the credentials module imports everything it needs at runtime
 * dynamically, so nobody picks up google-auth-library to run the sink suite.
 *
 * Explicit named re-exports only. `export *` is banned here for the same reason it is
 * banned in index.ts.
 */

export { NOTE_SINK_CONFORMANCE_SCENARIOS, describeNoteSinkConformance } from "./sink-conformance.js";
export type {
  ConformanceTestPrimitives,
  SinkConformanceScenario,
  SinkConformanceSupport,
  SinkHarness,
  SinkHarnessFactory,
} from "./sink-conformance.js";

export {
  GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS,
  GOOGLE_CREDENTIALS_FIXTURES,
  describeGoogleCredentialsConformance,
} from "./google-credentials-conformance.js";
export type {
  CredentialsConformanceScenario,
  CredentialsConformanceSupport,
  CredentialsFixture,
  CredentialsGoldenFixture,
  CredentialsHarnessFactory,
  CredentialsWriterHarness,
} from "./google-credentials-conformance.js";
```

In `package.json`, change:

```json
    "./testing": "./src/testing/sink-conformance.ts"
```

to:

```json
    "./testing": "./src/testing/index.ts"
```

- [ ] **Step 2: Create the conformance module**

Create `src/testing/google-credentials-conformance.ts`:

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ConformanceTestPrimitives } from "./sink-conformance.js";

/**
 * The executable contract for the Google credentials file.
 *
 * Core READS this file and never writes it, so the contract has to be enforceable
 * against a writer core knows nothing about — in another process, in another language.
 * Prose drifts; this does not. Modelled on NOTE_SINK_CONFORMANCE_SCENARIOS, and shipped
 * under the same rule: this module is SHIPPED API, not a test. It imports no test runner
 * and no assertion library, and every scenario is a plain async function that throws on
 * failure.
 *
 * The language boundary is `write()`. A writer in another language supplies a harness
 * that shells out to itself; the scenarios never know about it, exactly as SinkHarness
 * already hides transport from the sink scenarios.
 *
 * Two imports are deferred to `await import(...)` inside the scenarios that use them:
 * `google-auth-library` and `../google/file-token-provider.js`. `shorthand-core/testing`
 * is one barrel serving both suites, and a Markdown sink implementer running the sink
 * contract must not acquire google-auth-library, or core's Google module, as a side
 * effect of that packaging choice. `node:fs/promises` and `node:path` are imported
 * statically on purpose: they are Node built-ins already resolved in any process running
 * this suite, so deferring them would cost readability and buy nothing.
 */

export type CredentialsFixture = Readonly<{
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** Optional, mirroring GoogleCredentials: a credential with no target is still a credential. */
  document_id?: string;
  folder_id?: string;
}>;

export type CredentialsWriterHarness = Readonly<{
  /** Write these credentials wherever the implementation writes them, and report the path. */
  write(credentials: CredentialsFixture): Promise<string>;
  dispose?(): Promise<void>;
}>;

export type CredentialsHarnessFactory = () => Promise<CredentialsWriterHarness>;

/**
 * Declared rather than probed, following the sink suite: a scenario that cannot run on
 * this platform shows up as a `todo` in the report instead of being silently absent.
 */
export type CredentialsConformanceSupport = Readonly<{
  /** POSIX file modes are meaningful here. False/absent on Windows, where the file inherits %APPDATA%'s ACL. */
  posixPermissions?: boolean;
}>;

export type CredentialsConformanceScenario = Readonly<{
  name: string;
  requires?: keyof CredentialsConformanceSupport;
  run(createHarness: CredentialsHarnessFactory): Promise<void>;
}>;

export type CredentialsGoldenFixture = Readonly<{
  credentials: CredentialsFixture;
  /** The exact file contents, byte for byte, including the trailing newline. */
  bytes: string;
}>;

const MINIMAL: CredentialsFixture = {
  type: "authorized_user",
  client_id: "1234567890-conformance.apps.googleusercontent.com",
  client_secret: "conformance-client-secret",
  refresh_token: "conformance-refresh-token",
  document_id: "conformance-document-id",
};

const WITH_FOLDER: CredentialsFixture = { ...MINIMAL, folder_id: "conformance-folder-id" };

/**
 * Canonical credentials paired with their exact expected bytes.
 *
 * Shipped as data, not as a serializer, because the writer is in another language: a
 * unit test over there can assert against these bytes with no JavaScript involved. Key
 * ORDER is part of the artifact — a byte comparison has no meaning without one — and it
 * is the order the file's own documentation gives: Google's four first, ours after.
 *
 * An absent optional field is OMITTED, never written as null: `document_id` and
 * `folder_id` both keep their slot in the order and simply do not appear when the writer
 * has no value, which is the same rule exactOptionalPropertyTypes imposes on the types.
 * Both fixtures below carry a document_id, so their bytes do not depend on that rule —
 * the omission is pinned by the reader's own tests instead.
 */
export const GOOGLE_CREDENTIALS_FIXTURES: Readonly<{
  minimal: CredentialsGoldenFixture;
  withFolder: CredentialsGoldenFixture;
}> = Object.freeze({
  minimal: Object.freeze({
    credentials: MINIMAL,
    bytes: [
      "{",
      '  "type": "authorized_user",',
      '  "client_id": "1234567890-conformance.apps.googleusercontent.com",',
      '  "client_secret": "conformance-client-secret",',
      '  "refresh_token": "conformance-refresh-token",',
      '  "document_id": "conformance-document-id"',
      "}",
      "",
    ].join("\n"),
  }),
  withFolder: Object.freeze({
    credentials: WITH_FOLDER,
    bytes: [
      "{",
      '  "type": "authorized_user",',
      '  "client_id": "1234567890-conformance.apps.googleusercontent.com",',
      '  "client_secret": "conformance-client-secret",',
      '  "refresh_token": "conformance-refresh-token",',
      '  "document_id": "conformance-document-id",',
      '  "folder_id": "conformance-folder-id"',
      "}",
      "",
    ].join("\n"),
  }),
});

/* Assertion helpers. Deliberately dependency-free so no assertion library — and in
 * particular no test runner — leaks into shipped code. */

function fail(message: string): never {
  throw new Error(`Google credentials conformance: ${message}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (!Object.is(actual, expected)) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function withHarness(
  createHarness: CredentialsHarnessFactory,
  body: (harness: CredentialsWriterHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await body(harness);
  } finally {
    await harness.dispose?.();
  }
}

async function directoryEntries(path: string): Promise<readonly string[]> {
  return [...await readdir(dirname(path))].sort();
}

/**
 * Whether a directory entry looks like an unfinished write rather than a settled file.
 *
 * Deliberately a name shape rather than "anything that is not the target": the
 * credentials file's directory is the shared Shorthand config directory and may hold
 * other legitimate files, so a strict "nothing else may exist" check would fail an
 * honest writer on a real machine.
 */
function looksTemporary(entry: string, target: string): boolean {
  if (entry === target) return false;
  return /\.(tmp|temp|partial|swp)$/i.test(entry)
    || entry.startsWith(`.${target}`)
    || entry.startsWith(`${target}.`);
}

export const GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS: readonly CredentialsConformanceScenario[] = [
  {
    name: "writes to core's own credentialsPath(), not a re-derived one",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The scenario that stops a writer re-deriving the platform config directory and
      // drifting from core's. Core owns that resolution; a writer satisfies it.
      //
      // Against core's own reference harness this scenario is vacuous — that harness calls
      // credentialsPath() to decide where to write, so this compares the function to
      // itself. It earns its keep against the two callers that matter: the wrong-path
      // mutation in core's own mutation sweep, and a real external writer that computed
      // the path in another language.
      const { credentialsPath } = await import("../google/file-token-provider.js");
      assertEqual(await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials), credentialsPath(), "reported write path");
    }),
  },
  {
    name: "core can read the file back with every field intact",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      const { readCredentials } = await import("../google/file-token-provider.js");
      const fixture = GOOGLE_CREDENTIALS_FIXTURES.withFolder.credentials;
      const result = await readCredentials(await write(fixture));
      if (!result.ok) fail(`core rejected the written file: ${result.message}`);
      for (const [key, expected] of Object.entries(fixture)) {
        assertEqual((result.value as Record<string, unknown>)[key], expected, `field ${key}`);
      }

      // A credential with no target must still READ. document_id is optional: nothing in
      // core reads it off this file, so requiring it would only make a usable credential
      // unreadable — and it would force whoever performs consent to obtain a target in the
      // same step, foreclosing a "connect now, choose the target next" flow.
      const { document_id: _target, ...withoutTarget } = fixture;
      const noTarget = await readCredentials(await write(withoutTarget));
      if (!noTarget.ok) fail(`core rejected a credential with no document_id: ${noTarget.message}`);
    }),
  },
  {
    name: 'the type discriminator is exactly "authorized_user"',
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      const path = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      assertEqual(parsed.type, "authorized_user", "type");
    }),
  },
  {
    name: "google-auth-library's own ADC loader accepts the file",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The scenario that actually pins ADC alignment. Everything else here could pass
      // against a home-grown format that merely looks similar.
      const { UserRefreshClient } = await import("google-auth-library");
      const path = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      UserRefreshClient.fromJSON(parsed);
    }),
  },
  {
    name: "the file is mode 0600",
    requires: "posixPermissions",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      const path = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      assertEqual((await stat(path)).mode & 0o777, 0o600, "file mode");
    }),
  },
  {
    name: "an overwrite is wholesale: a field the second write omits is gone",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // Pins the deletion of the merge. A writer that helpfully preserves fields has
      // reintroduced a merge protocol, which is where the silent data loss lived.
      await write(GOOGLE_CREDENTIALS_FIXTURES.withFolder.credentials);
      const path = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      check(!("folder_id" in parsed), "folder_id survived an overwrite that omitted it");
    }),
  },
  {
    name: "a write leaves no temp-file debris behind",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      // The observable half of the write-then-rename requirement. Core no longer controls
      // the writer and reads this file during a live capture, so a torn read is
      // indistinguishable from a corrupt one.
      //
      // TWO checks, because either alone is blind. The FIRST write's own listing is
      // checked for temp-shaped names: a baseline taken after that write already contains
      // whatever the first write left behind, so a writer that dies between write and
      // rename on a fresh machine — the realistic Rust failure — would pass a
      // before/after comparison. And the second write is then compared against the first
      // write's listing, which is what catches a writer whose temp name varies per call
      // and so never leaves the same entry twice.
      const first = await write(GOOGLE_CREDENTIALS_FIXTURES.minimal.credentials);
      const target = basename(first);
      const before = await directoryEntries(first);
      check(before.includes(target), "the credentials file is not in its own directory listing");
      const strays = before.filter((entry) => looksTemporary(entry, target));
      check(strays.length === 0, `the first write left temp-file debris: ${JSON.stringify(strays)}`);

      await write(GOOGLE_CREDENTIALS_FIXTURES.withFolder.credentials);
      const after = await directoryEntries(first);
      check(
        after.length === before.length && after.every((entry, index) => entry === before[index]),
        `a write added or left entries in the directory: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
      );
    }),
  },
  {
    name: "the bytes match the golden fixture exactly",
    run: (createHarness) => withHarness(createHarness, async ({ write }) => {
      for (const golden of [GOOGLE_CREDENTIALS_FIXTURES.minimal, GOOGLE_CREDENTIALS_FIXTURES.withFolder]) {
        const path = await write(golden.credentials);
        assertEqual(await readFile(path, "utf8"), golden.bytes, "file bytes");
      }
    }),
  },
];

/**
 * Register every scenario with a caller-supplied runner. Scenarios whose capability the
 * platform does not declare are reported as `todo` when the runner supports it, so an
 * unrun scenario is visible rather than silently absent.
 */
export function describeGoogleCredentialsConformance(
  primitives: ConformanceTestPrimitives,
  name: string,
  createHarness: CredentialsHarnessFactory,
  support: CredentialsConformanceSupport = {},
): void {
  const { describe, test } = primitives;
  describe(`Google credentials conformance: ${name}`, () => {
    for (const scenario of GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS) {
      if (scenario.requires !== undefined && support[scenario.requires] !== true) {
        if (test.todo !== undefined) test.todo(scenario.name, () => {});
        continue;
      }
      test(scenario.name, () => scenario.run(createHarness));
    }
  });
}
```

- [ ] **Step 3: Create the test-only correct writer**

Create `test/fixtures/credentials-writer.ts`:

```ts
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialsFixture } from "../../src/testing/google-credentials-conformance.js";

/**
 * A deliberately correct writer of the Google credentials file, for core's own tests.
 *
 * It lives under test/ and not under src/ on purpose: core is a pure reader, and nothing
 * it ships may write this file. This exists only so core's conformance scenarios have
 * something to run against — a suite that has never been run at all is not evidence of
 * anything, and one that has only ever been run green is barely more.
 */
export const CREDENTIALS_KEY_ORDER = [
  "type", "client_id", "client_secret", "refresh_token", "document_id", "folder_id",
] as const;

export function serializeCredentials(credentials: CredentialsFixture): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CREDENTIALS_KEY_ORDER) {
    const value = (credentials as Record<string, unknown>)[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writeCredentialsFile(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  // Same-directory temp then rename: a cross-filesystem rename is not atomic, and core
  // reads this file during a live capture where a torn read looks like a corrupt one.
  const temporary = join(dirname(path), `.google-credentials.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, body, "utf8");
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
  return path;
}
```

- [ ] **Step 4: Write the conformance test against the correct writer**

Create `test/google-credentials-conformance.test.ts`:

```ts
import { afterEach, describe, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeGoogleCredentialsConformance } from "shorthand-core/testing";
import type { CredentialsFixture, CredentialsWriterHarness } from "shorthand-core/testing";
import { credentialsPath } from "../src/google/file-token-provider.js";
import { serializeCredentials, writeCredentialsFile } from "./fixtures/credentials-writer.js";

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Points every environment variable shorthandConfigDirectory() consults at a scratch
 * directory, so credentialsPath() resolves inside it on every platform, and restores
 * them afterwards. The path scenario compares against credentialsPath() with the real
 * process.env, so there is no way to run it without redirecting the real one.
 *
 * This mutates GLOBAL process.env, and it is safe for exactly one reason: `bun test` runs
 * test FILES one at a time, so no other file observes the window in which HOME and APPDATA
 * point at a temp directory. A parallel test runner would turn this into a heisenbug in
 * whichever file happened to read the config directory at the wrong moment —
 * test/config.test.ts first among them. If this suite is ever run concurrently, this
 * helper has to be replaced by passing an explicit environment into credentialsPath(),
 * which already accepts one.
 */
export async function withScratchConfigDirectory(): Promise<{ restore(): void }> {
  const scratch = await mkdtemp(join(tmpdir(), "google-credentials-conformance-"));
  scratchDirectories.push(scratch);
  const keys = ["APPDATA", "XDG_CONFIG_HOME", "HOME", "USERPROFILE"] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = scratch;
  return {
    restore: () => {
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

export async function createCorrectHarness(): Promise<CredentialsWriterHarness> {
  const scope = await withScratchConfigDirectory();
  return {
    write: (credentials: CredentialsFixture) =>
      writeCredentialsFile(credentialsPath(), serializeCredentials(credentials)),
    dispose: async () => { scope.restore(); },
  };
}

describeGoogleCredentialsConformance(
  { describe, test },
  "the reference writer",
  createCorrectHarness,
  { posixPermissions: process.platform !== "win32" },
);
```

- [ ] **Step 5: Run the test**

Run: `bun test test/google-credentials-conformance.test.ts`
Expected: PASS — seven scenarios pass, and the `mode 0600` scenario passes on macOS/Linux or shows as
`todo` on Windows. If it shows as a *silently absent* test rather than a `todo`, `bun:test`'s
`test.todo` is not being picked up; report that rather than removing the flag.

**Green here is not yet evidence of anything** — see the note in this task's Context. Task 9 is this
task's red phase and must follow immediately, in the same session.

If the golden-bytes scenario fails, compare the actual bytes against
`GOOGLE_CREDENTIALS_FIXTURES.minimal.bytes` character by character before changing either — the
fixture is the artifact another language compiles against, so it is the thing least free to move.

- [ ] **Step 6: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS. `typecheck` is the one that proves the `package.json` `exports` change
resolved: **two** existing files import `shorthand-core/testing` and now go through the barrel —
`test/markdown-sink.test.ts:9` (`describeNoteSinkConformance`) and `test/google-docs-sink.test.ts:2`
(`describeNoteSinkConformance`, `SinkHarness`). Confirm both still pass; the reviewer applied this
change in the worktree, verified both, and reverted.

- [ ] **Step 7: Commit**

```bash
git add src/testing/google-credentials-conformance.ts src/testing/index.ts package.json \
        test/fixtures/credentials-writer.ts test/google-credentials-conformance.test.ts
git commit -m "feat: publish the credentials file contract as runnable scenarios and golden bytes"
```

---

### Task 9: Prove the conformance suite bites, with deliberately wrong writers

**Files:**
- Modify: `test/google-credentials-conformance.test.ts`

**Interfaces:**
- Consumes: `GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS` and `GOOGLE_CREDENTIALS_FIXTURES` from Task 8,
  plus `withScratchConfigDirectory` and `serializeCredentials` from that task's test file.
- Produces: nothing importable.

**Context:** A conformance suite that has only ever been run against a correct implementation is not
evidence of anything. This repo already requires exactly this discipline elsewhere — the `test.each`
cases in `test/enhance-runner.test.ts` are verified by breaking the composition on purpose and
confirming the right cases fail. This task is the same move for the credentials contract.

**This task IS Task 8's red phase**, and the two commits must land together: do not stop, hand off or
push between them. Task 8 ends green against a correct writer, which proves nothing on its own; the
mutations below are what show each scenario can fail. If a mutation reveals a scenario that cannot
fail, the repair belongs in Task 8's scenario, not in the expectation here.

Six mutations, one per property the suite is supposed to protect. **Each asserts against the explicit
set of scenarios it should fail** — not "exactly one", which is not achievable: a writer that omits
`type` necessarily fails the `type` scenario, the read-back scenario, the ADC-loader scenario and the
golden-bytes scenario, and pretending otherwise would mean weakening the suite to fit the wording.
See "Questions for the human" item 7.

Note the Windows asymmetry: the `mode 0644` mutation is only detectable where `posixPermissions` is
declared, so on Windows that one mutation proves nothing. Skip the case there rather than letting it
report a false pass.

- [ ] **Step 1: Add the mutation sweep**

These tests are expected to PASS as soon as they are written — they are assertions *about* Task 8's
scenarios, and it is the wrong writers underneath them, not the tests themselves, that supply the red
phase. Append to `test/google-credentials-conformance.test.ts`:

```ts
import { expect } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS, GOOGLE_CREDENTIALS_FIXTURES } from "shorthand-core/testing";

/** Runs every scenario and returns the names of the ones that threw. */
async function failingScenarios(
  createHarness: () => Promise<CredentialsWriterHarness>,
  support: { posixPermissions: boolean },
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const scenario of GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS) {
    if (scenario.requires !== undefined && !support[scenario.requires]) continue;
    try {
      await scenario.run(createHarness);
    } catch {
      failures.push(scenario.name);
    }
  }
  return failures.sort();
}

const PATH_SCENARIO = "writes to core's own credentialsPath(), not a re-derived one";
const READ_SCENARIO = "core can read the file back with every field intact";
const TYPE_SCENARIO = 'the type discriminator is exactly "authorized_user"';
const LOADER_SCENARIO = "google-auth-library's own ADC loader accepts the file";
const MODE_SCENARIO = "the file is mode 0600";
const OVERWRITE_SCENARIO = "an overwrite is wholesale: a field the second write omits is gone";
const DEBRIS_SCENARIO = "a write leaves no temp-file debris behind";
const BYTES_SCENARIO = "the bytes match the golden fixture exactly";

/** Builds a harness whose write() is deliberately broken in one specific way. */
function brokenHarness(
  brokenWrite: (path: string, credentials: CredentialsFixture) => Promise<string>,
): () => Promise<CredentialsWriterHarness> {
  return async () => {
    const scope = await withScratchConfigDirectory();
    return {
      write: (credentials: CredentialsFixture) => brokenWrite(credentialsPath(), credentials),
      dispose: async () => { scope.restore(); },
    };
  };
}

async function plainWrite(path: string, body: string, mode = 0o600): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  if (process.platform !== "win32") await chmod(path, mode);
  return path;
}

describe("the credentials conformance suite detects a wrong writer", () => {
  const support = { posixPermissions: process.platform !== "win32" };

  test("a writer that picks its own path fails the path scenario", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) =>
        plainWrite(join(dirname(path), "elsewhere.json"), serializeCredentials(credentials))),
      support,
    );
    expect(failures).toEqual([PATH_SCENARIO]);
  });

  test("a writer using camelCase for our two fields fails the read-back and byte scenarios", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { document_id: documentId, folder_id: folderId, ...adc } = credentials;
        return plainWrite(path, `${JSON.stringify({
          ...adc, documentId, ...(folderId === undefined ? {} : { folderId }),
        }, null, 2)}\n`);
      }),
      support,
    );
    // The ADC half is still correct, so Google's loader still accepts it — which is
    // exactly why the read-back scenario has to exist separately from the loader one.
    expect(failures).toEqual([READ_SCENARIO, BYTES_SCENARIO].sort());
  });

  test("a writer that omits type fails the type, read-back, loader and byte scenarios", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => {
        const { type: _type, ...rest } = credentials;
        return plainWrite(path, `${JSON.stringify(rest, null, 2)}\n`);
      }),
      support,
    );
    expect(failures).toEqual([TYPE_SCENARIO, READ_SCENARIO, LOADER_SCENARIO, BYTES_SCENARIO].sort());
  });

  test.skipIf(process.platform === "win32")("a writer using mode 0644 fails only the permissions scenario", async () => {
    const failures = await failingScenarios(
      brokenHarness((path, credentials) => plainWrite(path, serializeCredentials(credentials), 0o644)),
      support,
    );
    expect(failures).toEqual([MODE_SCENARIO]);
  });

  test("a writer that preserves folder_id across an overwrite fails the overwrite scenario", async () => {
    // The anti-merge scenario. This is the mutation that proves deleting mergeCredentials
    // is enforced rather than merely intended.
    //
    // `previous` is declared INSIDE the factory, so every scenario in the sweep gets a
    // fresh merging writer. Hoisted outside it, one `previous` accumulates across all
    // eight scenarios: by the time the golden-bytes scenario runs it still carries the
    // folder_id an earlier scenario wrote, so the bytes fail too and the expected set
    // becomes [BYTES, OVERWRITE] — a second failure that says nothing about the merge.
    // This is not hypothetical; it is what the first draft of this test did.
    //
    // brokenHarness() is deliberately not used here: it takes a write function, and this
    // mutation needs per-harness state, which only a factory can hold.
    const failures = await failingScenarios(
      async () => {
        const scope = await withScratchConfigDirectory();
        let previous: Record<string, unknown> = {};
        return {
          write: (credentials: CredentialsFixture) => {
            previous = { ...previous, ...credentials };
            return plainWrite(credentialsPath(), serializeCredentials(previous as CredentialsFixture));
          },
          dispose: async () => { scope.restore(); },
        };
      },
      support,
    );
    expect(failures).toEqual([OVERWRITE_SCENARIO]);
  });

  test("a writer that leaves its temp file behind fails the debris scenario", async () => {
    // A FIXED temp name on purpose, and the debris scenario must catch it on the FIRST
    // write: a writer that dies between write and rename does so on whichever run it
    // crashes, including the first, and a scenario that only compares before/after across
    // a second write is blind to that — it would take its baseline with the debris already
    // in it. Task 8's scenario checks the first write's own listing for temp-shaped names
    // for exactly this reason.
    const failures = await failingScenarios(
      brokenHarness(async (path, credentials) => {
        await plainWrite(join(dirname(path), ".google-credentials.tmp"), "leftover");
        return plainWrite(path, serializeCredentials(credentials));
      }),
      support,
    );
    expect(failures).toEqual([DEBRIS_SCENARIO]);
  });
});
```

Merge the new `import { expect } from "bun:test";` into the file's existing `bun:test` import line
rather than adding a second one, and likewise fold the `node:fs/promises` and `node:path` names into
the existing import lines. `isolatedModules` does not forbid duplicate import statements, but two
imports from one specifier is noise a reviewer has to reconcile.

- [ ] **Step 2: Run the tests**

Run: `bun test test/google-credentials-conformance.test.ts`
Expected: PASS — the reference writer passes all scenarios, and each broken writer fails exactly the
set named.

If a mutation's actual failure set differs from the expected one, **do not adjust the expectation to
match**. Work out why first: an extra failure means a scenario is over-broad or a mutation is leaking
state between scenarios, and a missing failure means a scenario is not testing what it claims. The
repair belongs in Task 8's scenario or in the mutation, not in the expected set — and either way it is
a real finding worth reporting to the human.

- [ ] **Step 3: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS.

- [ ] **Step 4: Commit**

```bash
git add test/google-credentials-conformance.test.ts
git commit -m "test: run the credentials contract against wrong writers, not only a right one"
```

---

### Task 10: Make the documentation true, bump to 0.8.0, and hand the release to the human

**Files:**
- Modify: `docs/CONTRACT.md` (line 23, the §1 table at lines 25–29, the paragraph at lines 60–63, and
  a new §5.4)
- Modify: `package.json` (`version`)
- Modify: `.gitignore` (line 3)

**Interfaces:**
- Produces: version `0.8.0` in `package.json` and a pushed branch. **Tagging and merging to `main` are
  the human's steps, not this task's** — see Step 8.
- Consumes: every preceding task. This is last because the `BREAKING CHANGE:` footer must name
  everything the branch actually removed.

**Context:** Four documentation defects, all verified in this pass:

1. **`docs/CONTRACT.md:23` says "There are three entry points."** There are four —
   `package.json`'s `exports` lists `.`, `./markdown`, `./google` and `./testing`.
2. **The §1 table has no `shorthand-core/google` row**, and the whole document contains **zero
   occurrences of the string "google"** (verified: `grep -in "google" docs/CONTRACT.md` returns
   nothing). The document that describes the public surface does not mention an entire entry point.
3. **`docs/CONTRACT.md:62` cites `test/consumer-imports.test.ts`, which does not exist** (verified
   against a listing of `test/`). This is the serious one: it is not stale prose, it is a false
   assurance in the document external sink implementers are told is "everything you need."
   **Correction to the spec:** it also claims `docs/DESIGN.md:246` cites the file as though it
   existed. It does not — DESIGN.md:246 correctly records that the file "was deleted outright" and
   explains why. **DESIGN.md needs no change.**
4. The `shorthand-core/testing` row must gain the credentials-conformance exports.
5. **`.gitignore:3` still names the deleted command**: `# Local secrets (e.g. GOOGLE_OAUTH_CLIENT_ID/SECRET for google-login) — never committed.`
   The ignore rule itself stays — a local `.env` is still not committed — but the parenthetical points
   at a command that no longer exists anywhere in the repo, and it is the last such reference.

**Version bump `0.7.0` → `0.8.0`.** On the `0.x` line, minor is the breaking slot: removing or
retyping an exported symbol is a minor bump, not a patch. Six exported symbols were removed or
retyped.

**`obsidian-shorthand` consumes this package as a pinned GitHub tag**, so it is insulated until
someone bumps the pin — and the pin bump is the first step of any plugin work that follows this. The
removed symbols are all under `shorthand-core/google`, which a Markdown plugin has no reason to
import, so a clean bump is expected. That is a reason to expect no breakage, not a reason to skip
the footer.

**`package.json` `dependencies` must be byte-identical to what it was before this branch.**
`google-auth-library` is still used by the token provider, `googleapis` by `GoogleApiDocsClient`,
`marked` by `renderer.ts`. This change shrinks core's surface, not its dependency tree.

- [ ] **Step 1: Fix the entry-point count and add the `google` row**

In `docs/CONTRACT.md`, change `There are three entry points.` to `There are four entry points.`

In the §1 table, insert this row after the `shorthand-core/markdown` row and before the
`shorthand-core/testing` row:

```markdown
| `shorthand-core/google` | The Google Docs sink and the pieces it needs: `GoogleDocsNoteSink`, `GOOGLE_DOCS_SCOPE`, `GoogleApiDocsClient` and its API types, and the credentials reader — `FileTokenProvider`, `credentialsPath`, `readCredentials`, `GoogleCredentials`, `CredentialsReadResult`, `FileTokenProviderOptions` | Google Docs consumers only. **A Markdown or other API sink must not import this.** Core reads the credentials file and never writes it; see §5.4 |
```

Replace the `shorthand-core/testing` row with:

```markdown
| `shorthand-core/testing` | The executable contracts. For the sink port: `NOTE_SINK_CONFORMANCE_SCENARIOS`, `describeNoteSinkConformance`, `SinkHarness`, `SinkConformanceSupport`, `ConformanceTestPrimitives`. For the credentials file: `GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS`, `describeGoogleCredentialsConformance`, `GOOGLE_CREDENTIALS_FIXTURES`, `CredentialsWriterHarness`, `CredentialsFixture`, `CredentialsConformanceSupport` | Any sink's test suite; any writer of the Google credentials file |
```

- [ ] **Step 2: Stop claiming a deleted test closes a hole**

In `docs/CONTRACT.md`, replace this paragraph (currently lines 60–63; line 64 is blank and stays):

```markdown
A second hole the `exports` map cannot see: a **relative** import that escapes a consumer's
own root (`../../src/note/writer.js`) bypasses bare-specifier resolution entirely.
`test/consumer-imports.test.ts` closes it by scanning consumer roots for relative specifiers
that resolve outside the consumer.
```

with:

```markdown
A second hole the `exports` map cannot see: a **relative** import that escapes a consumer's
own root (`../../src/note/writer.js`) bypasses bare-specifier resolution entirely. **Nothing
closes it today.** `test/consumer-imports.test.ts` used to, by scanning consumer roots for
relative specifiers that resolved outside the consumer; it went when the Obsidian plugin moved
to its own repository, because a consumer in another repo has no root inside this one left to
escape (`docs/DESIGN.md`). Vendoring a consumer back into this tree would reopen the hole and
would need that test back.
```

- [ ] **Step 3: Document the credentials contract in §5**

Insert this subsection as the last subsection of §5 — **not** at the end of the file. §5.3 runs to
line 371, the `---` separator that closes §5 is line 372, and `## 6. Consumers` begins on line 374.
Insert §5.4 after §5.3's last line and immediately **before** that `---`, so it sits inside §5 rather
than after the rule that ends it:

```markdown
### 5.4 The Google credentials file

`shorthand-core/google` **reads** `google-credentials.json` and never writes it. One writer
per file: a file with two writers has an invariant that lives in neither of them. Core's job
is to define the contract and enforce it executably.

The file is Google's Application Default Credentials `authorized_user` shape — `type`,
`client_id`, `client_secret`, `refresh_token`, which `google-auth-library`'s own
`UserRefreshClient.fromJSON` reads by those names, and which are the only fields a read
validates — plus `document_id` and `folder_id`, which are ours and are both optional. A
credential with no target is still a credential: core reads no `document_id` from this file
(the sink takes one as a constructor option), so requiring it would only make a usable
credential unreadable. An absent optional field is **omitted**, never `null`. Extra
top-level keys are ignored by Google's loader
and by core, so one superset file works where a sibling file would only re-create a torn
state between two writes. It lives at `credentialsPath()`, is 2-space-indented JSON with a
trailing newline and the key order above, is mode `0600` on non-Windows, and must be written
atomically — temp file in the same directory, then rename.

`describeGoogleCredentialsConformance` registers those requirements against your writer the
same way `describeNoteSinkConformance` does for a sink, with the language boundary at
`write()`; `GOOGLE_CREDENTIALS_FIXTURES` ships the exact expected bytes so a writer in another
language can assert against them without running JavaScript at all.
```

- [ ] **Step 4: Bump the version, and clear the last `google-login` reference**

In `package.json`, change `"version": "0.7.0"` to `"version": "0.8.0"`. Change nothing else —
`dependencies` and `devDependencies` stay byte-identical.

In `.gitignore`, change line 3 from:

```
# Local secrets (e.g. GOOGLE_OAUTH_CLIENT_ID/SECRET for google-login) — never committed.
```

to:

```
# Local secrets (e.g. GOOGLE_OAUTH_CLIENT_ID/SECRET) — never committed.
```

The `.env` / `.env.*` rules below it are unchanged: a developer's local secrets are still not
committed. Only the example naming a command that no longer exists goes.

- [ ] **Step 5: Run every verification the spec asks for**

Run each and confirm the stated result before committing:

```bash
grep -rniE "listenForRedirect|buildAuthorizationUrl|exchangeCode|generatePkceChallenge|ensureContainerDoc|trigger_onepick|google-login" src/ bin/
```
Expected: **no output.** (The pattern is scoped to identifiers on purpose: a bare `oauth` search
still matches `src/google/file-token-provider.ts`'s doc comment citing
`node_modules/google-auth-library/build/src/auth/oauth2client.js`, which is benign and expected.)

```bash
grep -n "mergeCredentials\|writeCredentials\|tabId" src/google/file-token-provider.ts
```
Expected: **no output.**

> **Scoped to that one file on purpose — do not widen it to `src/`.** `tabId` is the Google Docs
> API's own field name and is legitimate throughout `src/google/`: `docs-sink.ts` (including
> `GoogleDocsNoteSinkOptions.tabId` at L11 and `#tabId` at L29), `docs-client.ts:10,146`, and
> `requests.ts` (including the `buildWriteRequests` guard at L82). All are pinned by
> `test/google-requests.test.ts` and `test/google-docs-sink*.test.ts`; removing them breaks the
> working Docs sink. The spec's verification item 11 is worded the same way — "returns nothing under
> `src/google/file-token-provider.ts`".

```bash
grep -rni "google-login" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
```
Expected: **no output** — this is the check that `.gitignore:3` was caught along with the code.

```bash
grep -in "google" docs/CONTRACT.md
```
Expected: several hits now, including the new `shorthand-core/google` row.

```bash
bun bin/shorthand-notes.ts google-login; echo "exit=$?"
```
Expected: `exit=2`, the usage text on stderr, and **no mention of `google-login`** anywhere in it.
There is no `--help` flag — `runCli` dispatches on the first positional and falls through to
`usage(...)` for anything unrecognised, so an unknown command is how the usage text is read.

- [ ] **Step 6: Run the full gate**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`
Expected: all four PASS.

- [ ] **Step 7: Commit with the breaking-change footer**

```bash
git add docs/CONTRACT.md package.json .gitignore
git commit -m "feat!: core reads a Google credential it did not write

Obtaining a Google credential or a target is a consumer concern: it is
interactive, one-time and UI-adjacent, and the moment core has to open a
browser or render a consent screen the design has crossed out of core. What
core keeps is everything that happens after a credential and a target already
exist.

The credentials file is now Google's own ADC authorized_user shape plus our
document_id/folder_id, with one writer and no merge — a file with two writers
in two languages has an invariant that lives in neither of them, and the merge
such a scheme needs is where the silent data loss lived. Every existing
credentials file is unusable regardless: a refresh token is bound to the OAuth
client that issued it, and consent will be performed by a different client.

BREAKING CHANGE: shorthand-core/google no longer exports ensureContainerDoc,
ContainerDocResult, or writeCredentials. GoogleCredentials is retyped to the
ADC authorized_user superset (snake_case fields, no tabId, document_id and
folder_id both optional). readCredentials
now returns a validating CredentialsReadResult instead of
GoogleCredentials | undefined, and never throws. FileTokenProviderOptions no
longer takes clientId or clientSecret; both come from the credentials file.
The shorthand-notes google-login command is removed."
```

- [ ] **Step 8: Push the branch, then STOP**

This repo is private and single-user; pushing the branch needs no permission.

```bash
git push -u origin feat/core-sheds-consent
```

**Stop here and report to the human.** Do **not** merge to `main`, do not open or merge a PR, and do
not tag. Merging a breaking change and cutting the release it is published under are the human's
calls, not an executor's — `obsidian-shorthand` pins this package by tag, so a tag is a publication
event, and previous work went through PRs (`#1`, `#2`) that a person reviewed.

The report should say: the branch is pushed, the four-command gate is green, the version in
`package.json` is `0.8.0`, and the tag the human will want is annotated and bare (no `v` prefix):

```bash
# For the human, after they have merged — NOT for the executor to run:
git tag -a 0.8.0 -m "0.8.0 — core reads a Google credential it did not write"
git push origin 0.8.0
git ls-remote --tags origin '0.8.0^{}'
```

The last command is the check that the annotated tag points where they think: because it is
annotated, `git ls-remote --tags origin 0.8.0` returns the tag object rather than the commit.

---

## Self-Review Notes

**Spec coverage.** Every section of the spec maps to a task:

| Spec section | Task |
| --- | --- |
| "What core sheds" — whole files | 4, 5 |
| "What core sheds" — `bin/shorthand-notes.ts`, five edit sites | 3 |
| "What core sheds" — `src/google.ts` re-exports | 5 (`ensureContainerDoc`/`ContainerDocResult`), 6 (`writeCredentials`) |
| "The six `google-login` tests" | 2 |
| "The credentials file, as core now defines it" | 6 |
| "`client_id`/`client_secret` move INTO the file" | 7 |
| "`mergeCredentials` is deleted, deliberately" | 6 (deletion), 9 (the mutation that enforces it) |
| "Where per-capture `tabId` state lives" | No task — spec defers everything executable. See Questions item 13. |
| "The conformance fixture" | 8 (module, barrel, scenarios, golden bytes), 9 (mutations) |
| "The scope guard" — core's half | 1. Items 2–4 (copying it to `shorthand-config`) are out of scope. |
| "Sequencing: the deletion lands now" | Recorded in the plan's intro |
| "Documentation drift to resolve" | 10 |
| "New and changed tests" | 6 (malformed shapes, unknown keys), 7 (working client, caching), 8/9 (fixture), 1 (scope guard) |
| "The runtime prerequisite" / "OS keychain storage" / "Open questions" | Research and deferral; nothing executable |

**One numbered spec verification item has no task, deliberately.** Item 7 — "a file matching the
documented shape, placed at `credentialsPath()`, drives a successful `FileTokenProvider.getAccessToken()`
**against real Google**" — cannot be automated under this plan's no-live-network rule, and no task
attempts it. It is a **manual check the human performs once a credential exists again**, which will
not be until `shorthand-config` can write one. Recording it as a known gap rather than dropping it
silently: everything up to the network call is covered (Task 6's validation tests, Task 7's injected
refresher and its `UserRefreshClient.fromJSON` test, Task 8's ADC-loader scenario); what is untested
is the round-trip to Google's token endpoint. The spec's own "Open questions" item 2 already flags the
adjacent gap — nothing in core constructs a `FileTokenProvider` outside tests today, so there is not
even a call site to run it from.

**Deliberately not planned**, because the spec puts them elsewhere: the `shorthand-config` app and
its Rust consent port; copying the scope guard to that repo; the enhance/capture wiring, sink
selection, `addDocumentTab` and `tabId` minting; the per-capture state file's schema and lifecycle;
the keychain; `bun build --compile` on macOS.

**Type consistency.** `GoogleCredentials` (Task 6) is the exact type Task 7's refresher takes and
Task 8's `CredentialsFixture` mirrors structurally. `CredentialsReadResult`'s `{ ok, value }` /
`{ ok, message }` discrimination is used identically in Task 6's implementation, Task 6's tests and
Task 8's read-back scenario. `defaultRefresher`'s one-parameter form (Task 7) is what Task 7's tests
call. `ConformanceTestPrimitives` (Task 8) is imported from `sink-conformance.ts:307-313` and not
redefined. The eight scenario `name` strings in Task 8 are copied verbatim into Task 9's constants;
if any is edited in Task 8, Task 9's constants must be edited to match.

**No placeholders.** Every step names exact files, exact commands and exact expected outcomes, and
every code step carries the code. The one place a step says "adjust against the installed types" —
Task 7 Step 4 — deliberately forbids the shortcut (`as never`) and says what to report instead.
