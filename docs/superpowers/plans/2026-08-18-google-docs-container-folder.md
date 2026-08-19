# Google Docs Container Folder + Token Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `shorthand-notes google-login --create` (app creates its own folder + container Google
Doc instead of the user picking an existing one) and fix a real inefficiency where every Google
Docs API call re-authenticates from scratch instead of reusing a cached token.

**Architecture:** Two independent pieces. (1) A new `ensureContainerDoc` helper wraps the Drive v3
and Docs v1 APIs (both already available via the `googleapis` dependency) to create-or-reuse a
folder and a doc inside it, wired into the existing `google-login` CLI flow behind a `--create`
flag that skips the Picker step. (2) `FileTokenProvider`'s default refresher currently constructs a
brand-new `OAuth2Client` on every call, defeating that library's own built-in token caching — fixed
by holding one instance across calls.

**Tech Stack:** `googleapis`' `drive_v3`/`docs_v1` (already a dependency), `google-auth-library`'s
`OAuth2Client` (already a dependency, its own built-in token caching is what task 5 restores rather
than replaces).

**Spec:** `docs/superpowers/specs/2026-08-18-google-docs-sink.md` — the "Phase 1c addendum" and
"Follow-up fix: token caching" sections at the end of that file. Everything above those sections is
already-shipped work on `feat/google-docs-sink` (merged-pending-PR); this plan's branch,
`feat/google-docs-container-folder`, was cut from that branch and already has all of it.

## Global Constraints

- Scope stays `https://www.googleapis.com/auth/drive.file` — never combined with, or widened to,
  any other scope. (`test/google-scope-guard.test.ts` already greps for this across `src/`/`bin/`;
  no new occurrence of a Google auth scope string should appear anywhere outside the existing
  `GOOGLE_DOCS_SCOPE` constant.)
- `exactOptionalPropertyTypes: true` — optional fields omitted via conditional spread, never set to
  `undefined`.
- Explicit named re-exports only from `src/google.ts`, never `export *`.
- `bun test` and `bun run typecheck` must pass at the end of every task. This repo has no `lint`
  script — don't invoke or expect one.
- No live network in any test. Every network-touching function takes its transport as an injectable
  parameter (matching `GoogleApiDocsClient`'s `docsResource?` seam and `FileTokenProvider`'s
  `refreshAccessToken?` seam already in this codebase).
- `bin/shorthand-notes.ts` is internal to this package (may deep-import `../src/google/...js`
  directly) but its diff for tasks that touch it should stay scoped to the functions this plan
  actually changes (`runGoogleLogin`, `KNOWN_FLAGS`, the `usage()` string) — don't reformat or
  reorder anything else in that ~550-line file.
- Prefer off-the-shelf: task 5 exists specifically to stop defeating `google-auth-library`'s own
  built-in token caching, not to add a new caching layer or dependency.

---

### Task 1: `GoogleCredentials` gains an optional `folderId`

**Files:**
- Modify: `src/google/file-token-provider.ts`
- Test: `test/google-file-token-provider.test.ts`

**Interfaces:**
- Produces: `GoogleCredentials` gains `folderId?: string`. `mergeCredentials`'s `update` parameter
  gains an optional `folderId?: string`.
- Consumed by: Task 3 (`ensureContainerDoc` reads/writes it via the CLI), Task 4 (`runGoogleLogin`
  passes it through).

**Context:** `GoogleCredentials` today is `{ refreshToken, documentId, tabId? }`. The container-doc
flow (Task 3/4) needs to remember a created folder's ID across runs the same way `tabId` is already
preserved across a re-login — `mergeCredentials` already has exactly this "preserve a field the
current update doesn't know about" pattern for `tabId`; `folderId` needs the identical treatment,
plus the ability for a caller that DOES know a new `folderId` to set it.

- [ ] **Step 1: Write the failing tests**

Add to `test/google-file-token-provider.test.ts`, inside the existing `describe("mergeCredentials"`
block:

```ts
  test("preserves an existing folderId when the update doesn't specify one", () => {
    const existing: GoogleCredentials = { refreshToken: "old-rt", documentId: "old-doc", folderId: "folder-1" };
    const merged = mergeCredentials(existing, { refreshToken: "new-rt", documentId: "new-doc" });
    expect(merged).toEqual({ refreshToken: "new-rt", documentId: "new-doc", folderId: "folder-1" });
  });

  test("a new folderId in the update overrides an existing one", () => {
    const existing: GoogleCredentials = { refreshToken: "old-rt", documentId: "old-doc", folderId: "folder-1" };
    const merged = mergeCredentials(existing, { refreshToken: "new-rt", documentId: "new-doc", folderId: "folder-2" });
    expect(merged).toEqual({ refreshToken: "new-rt", documentId: "new-doc", folderId: "folder-2" });
  });

  test("omits folderId entirely when neither existing nor update has one", () => {
    const merged = mergeCredentials(undefined, { refreshToken: "new-rt", documentId: "new-doc" });
    expect(merged).toEqual({ refreshToken: "new-rt", documentId: "new-doc" });
    expect("folderId" in merged).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/google-file-token-provider.test.ts`
Expected: FAIL — `folderId` not assignable / not present on the merged result (TS error on the test
file itself, since `GoogleCredentials` doesn't have `folderId` yet).

- [ ] **Step 3: Implement**

In `src/google/file-token-provider.ts`, change:

```ts
export type GoogleCredentials = Readonly<{ refreshToken: string; documentId: string; tabId?: string }>;
```

to:

```ts
export type GoogleCredentials = Readonly<{
  refreshToken: string;
  documentId: string;
  tabId?: string;
  folderId?: string;
}>;
```

And change `mergeCredentials`:

```ts
export function mergeCredentials(
  existing: GoogleCredentials | undefined,
  update: Readonly<{ refreshToken: string; documentId: string }>,
): GoogleCredentials {
  return {
    refreshToken: update.refreshToken,
    documentId: update.documentId,
    ...(existing?.tabId === undefined ? {} : { tabId: existing.tabId }),
  };
}
```

to:

```ts
export function mergeCredentials(
  existing: GoogleCredentials | undefined,
  update: Readonly<{ refreshToken: string; documentId: string; folderId?: string }>,
): GoogleCredentials {
  const folderId = update.folderId ?? existing?.folderId;
  return {
    refreshToken: update.refreshToken,
    documentId: update.documentId,
    ...(existing?.tabId === undefined ? {} : { tabId: existing.tabId }),
    ...(folderId === undefined ? {} : { folderId }),
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/google-file-token-provider.test.ts && bun run typecheck`
Expected: PASS, including every pre-existing test in that file unmodified (the `tabId`-preservation
test and the round-trip test must still pass exactly as written — this proves the change is purely
additive).

- [ ] **Step 5: Commit**

```bash
git add src/google/file-token-provider.ts test/google-file-token-provider.test.ts
git commit -m "feat: let GoogleCredentials carry an optional folderId"
```

---

### Task 2: `buildAuthorizationUrl` gains an optional `usePicker` flag

**Files:**
- Modify: `src/google/oauth.ts`
- Test: `test/google-oauth.test.ts`

**Interfaces:**
- Produces: `buildAuthorizationUrl`'s options gain `usePicker?: boolean` (default `true` when
  omitted — existing callers/tests must see identical behavior).
- Consumed by: Task 4 (`runGoogleLogin` passes `usePicker: false` for `--create`).

**Context:** The create-a-container-doc flow has nothing to pick — there's no existing file to
choose, since the app is about to create one. `trigger_onepick=true` should be omitted for that
flow; the rest of the authorization URL (PKCE challenge, `access_type=offline`, `prompt=consent`,
scope) stays identical either way.

- [ ] **Step 1: Write the failing test**

Add to `test/google-oauth.test.ts`, inside the existing `describe("buildAuthorizationUrl"` block:

```ts
  test("omits trigger_onepick when usePicker is false", () => {
    const url = new URL(buildAuthorizationUrl({
      clientId: "c", redirectUri: "http://127.0.0.1:9999/callback",
      codeChallenge: "x", scope: "https://www.googleapis.com/auth/drive.file",
      usePicker: false,
    }));
    expect(url.searchParams.has("trigger_onepick")).toBe(false);
    // Everything else stays present — only the picker trigger is conditional.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge")).toBe("x");
  });

  test("usePicker defaults to true when omitted", () => {
    const url = new URL(buildAuthorizationUrl({
      clientId: "c", redirectUri: "http://127.0.0.1:9999/callback",
      codeChallenge: "x", scope: "https://www.googleapis.com/auth/drive.file",
    }));
    expect(url.searchParams.get("trigger_onepick")).toBe("true");
  });
```

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `bun test test/google-oauth.test.ts`
Expected: the new "omits trigger_onepick" test FAILs (the URL currently always has it); the
"defaults to true" test already passes against the current code — that's fine, it's there to pin
the default going forward, not to prove a regression right now.

- [ ] **Step 3: Implement**

In `src/google/oauth.ts`, change:

```ts
export function buildAuthorizationUrl(options: Readonly<{
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
}>): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("trigger_onepick", "true");
  return url.toString();
}
```

to:

```ts
export function buildAuthorizationUrl(options: Readonly<{
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  /** Omit the Picker trigger when there's nothing to pick (e.g. the app is about to create its own target). Defaults to true. */
  usePicker?: boolean;
}>): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (options.usePicker ?? true) url.searchParams.set("trigger_onepick", "true");
  return url.toString();
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/google-oauth.test.ts && bun run typecheck`
Expected: PASS, including every pre-existing test in the file (in particular the original
"includes PKCE, offline access, consent prompt, and the one-pick trigger" test, which calls
`buildAuthorizationUrl` without `usePicker` at all and must still see `trigger_onepick=true`).

- [ ] **Step 5: Commit**

```bash
git add src/google/oauth.ts test/google-oauth.test.ts
git commit -m "feat: let buildAuthorizationUrl skip the Picker trigger"
```

---

### Task 3: `ensureContainerDoc` — create-or-reuse a folder and a doc inside it

**Files:**
- Create: `src/google/container-doc.ts`
- Test: `test/google-container-doc.test.ts`
- Modify: `src/google.ts`

**Interfaces:**
- Consumes: an authenticated `OAuth2Client` (from `google-auth-library`, already a dependency).
- Produces:
  ```ts
  export type ContainerDocResult = Readonly<{ folderId: string; documentId: string }>;
  export async function ensureContainerDoc(
    auth: OAuth2Client,
    existing: Readonly<{ folderId?: string; documentId?: string }>,
    options?: Readonly<{
      folderName?: string;
      docTitle?: string;
      /** Test seam only; production always uses google.drive({version:"v3",auth}).files. */
      driveFiles?: Pick<drive_v3.Drive["files"], "create" | "update" | "get">;
      /** Test seam only; production always uses google.docs({version:"v1",auth}).documents. */
      docsDocuments?: Pick<docs_v1.Docs["documents"], "create">;
    }>,
  ): Promise<ContainerDocResult>;
  ```
- Consumed by: Task 4 (`runGoogleLogin`).

**Context:** Spec's "Phase 1c addendum". If `existing.folderId` AND `existing.documentId` are both
already present (a second `--create` run), return them unchanged — **no API calls at all**, so a
repeat run never creates a duplicate folder or doc. Otherwise: create a folder via the Drive API,
create the container doc via the Docs API, then move the doc into the folder via the Drive API.
That move must use **both `addParents` and `removeParents`, not `addParents` alone**: Google's own
documentation for `files.update` (the `parents` field's doc comment in the installed `googleapis`
client's `drive/v3.d.ts`) is explicit that "a file can only have one parent folder... update
requests must use the `addParents` and `removeParents` parameters to modify the parents list."
Every file this flow moves already has a parent — a freshly-created doc from `documents.create` is
parented to My Drive root, and a picker-selected pre-existing doc is parented wherever the user
already keeps it — so fetch the file's current `parents` via `files.get(fileId, {fields:
"parents"})` first and pass them back as `removeParents` (comma-separated) on the same
`files.update` call; omitting `removeParents` either fails the request or produces an unsupported
multi-parent state. (The Docs API's `documents.create` has no `parents` field of its own — placing
a file in a folder is always a Drive-API-level operation, regardless of which API created the
file.) Default names both to `"Shorthand Meeting Notes"` when not given, since the user can rename
either in Drive afterward without breaking anything (the app tracks them by ID, never by name).

`GoogleDocsNoteSink` itself never calls this — it only ever consumes `documentId`/`tabId`. This
module exists purely for the one-time setup step in `google-login --create`.

- [ ] **Step 1: Write the failing tests**

Create `test/google-container-doc.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { OAuth2Client } from "google-auth-library";
import { ensureContainerDoc } from "../src/google/container-doc.js";

function fakeAuth(): OAuth2Client {
  // ensureContainerDoc never actually calls anything on `auth` directly — it's
  // only threaded through to google.drive({auth})/google.docs({auth}), which
  // this test bypasses entirely via the driveFiles/docsDocuments seams below.
  return new OAuth2Client();
}

describe("ensureContainerDoc", () => {
  test("reuses an existing folderId and documentId without calling any API", async () => {
    const driveFiles = {
      create: async () => { throw new Error("must not be called when both IDs already exist"); },
      update: async () => { throw new Error("must not be called when both IDs already exist"); },
    };
    const docsDocuments = {
      create: async () => { throw new Error("must not be called when both IDs already exist"); },
    };
    const result = await ensureContainerDoc(
      fakeAuth(),
      { folderId: "existing-folder", documentId: "existing-doc" },
      { driveFiles, docsDocuments },
    );
    expect(result).toEqual({ folderId: "existing-folder", documentId: "existing-doc" });
  });

  test("creates a folder, then a doc, then moves the doc into the folder, when neither exists", async () => {
    const calls: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string; mimeType: string } }) => {
        calls.push(`drive.create:${params.requestBody.mimeType}`);
        expect(params.requestBody.mimeType).toBe("application/vnd.google-apps.folder");
        return { data: { id: "new-folder" } };
      },
      update: async (params: { fileId: string; addParents: string }) => {
        calls.push(`drive.update:${params.fileId}:${params.addParents}`);
        return { data: { id: params.fileId } };
      },
    };
    const docsDocuments = {
      create: async () => {
        calls.push("docs.create");
        return { data: { documentId: "new-doc" } };
      },
    };
    const result = await ensureContainerDoc(fakeAuth(), {}, { driveFiles, docsDocuments });
    expect(result).toEqual({ folderId: "new-folder", documentId: "new-doc" });
    expect(calls).toEqual(["drive.create:application/vnd.google-apps.folder", "docs.create", "drive.update:new-doc:new-folder"]);
  });

  test("defaults the folder/doc name to Shorthand Meeting Notes", async () => {
    const names: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string } }) => {
        names.push(params.requestBody.name);
        return { data: { id: "f1" } };
      },
      update: async () => ({ data: { id: "d1" } }),
    };
    const docsDocuments = {
      create: async (params: { requestBody: { title: string } }) => {
        names.push(params.requestBody.title);
        return { data: { documentId: "d1" } };
      },
    };
    await ensureContainerDoc(fakeAuth(), {}, { driveFiles, docsDocuments });
    expect(names).toEqual(["Shorthand Meeting Notes", "Shorthand Meeting Notes"]);
  });

  test("honours custom folderName/docTitle", async () => {
    const names: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string } }) => { names.push(params.requestBody.name); return { data: { id: "f1" } }; },
      update: async () => ({ data: { id: "d1" } }),
    };
    const docsDocuments = {
      create: async (params: { requestBody: { title: string } }) => { names.push(params.requestBody.title); return { data: { documentId: "d1" } }; },
    };
    await ensureContainerDoc(fakeAuth(), {}, { folderName: "My Folder", docTitle: "My Doc", driveFiles, docsDocuments });
    expect(names).toEqual(["My Folder", "My Doc"]);
  });

  test("creates only what's missing: reuses an existing folderId but still creates the doc", async () => {
    const calls: string[] = [];
    const driveFiles = {
      create: async () => { throw new Error("must not create a folder when one already exists"); },
      update: async (params: { fileId: string; addParents: string }) => {
        calls.push(`drive.update:${params.fileId}:${params.addParents}`);
        return { data: { id: params.fileId } };
      },
    };
    const docsDocuments = {
      create: async () => { calls.push("docs.create"); return { data: { documentId: "new-doc" } }; },
    };
    const result = await ensureContainerDoc(fakeAuth(), { folderId: "existing-folder" }, { driveFiles, docsDocuments });
    expect(result).toEqual({ folderId: "existing-folder", documentId: "new-doc" });
    expect(calls).toEqual(["docs.create", "drive.update:new-doc:existing-folder"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/google-container-doc.test.ts`
Expected: FAIL — module `../src/google/container-doc.js` not found.

- [ ] **Step 3: Implement**

Create `src/google/container-doc.ts`:

```ts
import { docs_v1, drive_v3, google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type ContainerDocResult = Readonly<{ folderId: string; documentId: string }>;

const DEFAULT_NAME = "Shorthand Meeting Notes";

export async function ensureContainerDoc(
  auth: OAuth2Client,
  existing: Readonly<{ folderId?: string; documentId?: string }>,
  options?: Readonly<{
    folderName?: string;
    docTitle?: string;
    driveFiles?: Pick<drive_v3.Drive["files"], "create" | "update" | "get">;
    docsDocuments?: Pick<docs_v1.Docs["documents"], "create">;
  }>,
): Promise<ContainerDocResult> {
  if (existing.folderId !== undefined && existing.documentId !== undefined) {
    return { folderId: existing.folderId, documentId: existing.documentId };
  }

  const driveFiles = options?.driveFiles ?? google.drive({ version: "v3", auth }).files;
  const docsDocuments = options?.docsDocuments ?? google.docs({ version: "v1", auth }).documents;

  let folderId = existing.folderId;
  if (folderId === undefined) {
    const folder = await driveFiles.create({
      requestBody: {
        name: options?.folderName ?? DEFAULT_NAME,
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id",
    });
    const createdFolderId = folder.data.id;
    if (createdFolderId === null || createdFolderId === undefined) {
      throw new Error("Drive API created a folder but returned no id");
    }
    folderId = createdFolderId;
  }

  let documentId = existing.documentId;
  if (documentId === undefined) {
    const doc = await docsDocuments.create({
      requestBody: { title: options?.docTitle ?? options?.folderName ?? DEFAULT_NAME },
    });
    const createdDocumentId = doc.data.documentId;
    if (createdDocumentId === null || createdDocumentId === undefined) {
      throw new Error("Docs API created a document but returned no documentId");
    }
    documentId = createdDocumentId;
  }

  // Runs whenever execution reaches here — i.e. whenever at least one of
  // folderId/documentId was missing (the "both already present" case already
  // returned above). Covers all three remaining combinations with one call:
  // folder new + doc new, folder new + doc pre-existing (the doc would
  // otherwise never get linked to the new folder at all), and folder
  // pre-existing + doc new. documents.create has no `parents` field of its
  // own — placing a file in a folder is always a Drive-API-level operation,
  // regardless of which API created the file.
  //
  // The move must supply both addParents and removeParents, not addParents alone — see
  // "Context" above for the Drive API contract this is fixing to. Every file reaching
  // this point already has a parent, so fetch it first and pass it back as removeParents.
  const current = await driveFiles.get({ fileId: documentId, fields: "parents" });
  const currentParents = current.data.parents;
  const removeParents = currentParents !== null && currentParents !== undefined && currentParents.length > 0
    ? currentParents.join(",")
    : undefined;
  await driveFiles.update({
    fileId: documentId,
    addParents: folderId,
    fields: "id",
    ...(removeParents === undefined ? {} : { removeParents }),
  });

  return { folderId, documentId };
}
```

(The shipped `ensureContainerDoc` additionally reports `folderCreated`/`documentCreated` on its
result and decorates a thrown error with the created folder's id — later fix-wave additions from
the final whole-branch code review, not part of this task's original scope.)

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/google-container-doc.test.ts && bun run typecheck`
Expected: PASS. If `drive_v3.Drive["files"].create`/`.update` or `docs_v1.Docs["documents"].create`'s
real parameter/response shapes differ from what's sketched above, adjust against the installed
`googleapis` package's actual types (`node_modules/googleapis/build/src/apis/drive/v3.d.ts` and
`.../docs/v1.d.ts`) — this is expected, normal adaptation work, same as every other task that's
touched `googleapis` types in this codebase so far.

- [ ] **Step 5: Re-export from the entry point**

In `src/google.ts`, add:

```ts
export { ensureContainerDoc } from "./google/container-doc.js";
export type { ContainerDocResult } from "./google/container-doc.js";
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/google/container-doc.ts test/google-container-doc.test.ts src/google.ts
git commit -m "feat: add ensureContainerDoc for the app-created folder+doc flow"
```

---

### Task 4: Wire `google-login --create` into the CLI

**Files:**
- Modify: `bin/shorthand-notes.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `ensureContainerDoc` (Task 3), `buildAuthorizationUrl`'s `usePicker` (Task 2),
  `mergeCredentials`'s `folderId` (Task 1).

**Context:** `runGoogleLogin` (already in `bin/shorthand-notes.ts`) currently always uses the
Picker and always requires a `pickedFileIds[0]`. Add a `--create` boolean flag: when present, skip
the Picker (`usePicker: false`), and after the OAuth code exchange, call `ensureContainerDoc`
instead of reading a picked file id. Read the current function in full before editing — it already
does `readCredentials()`/`mergeCredentials()`/`writeCredentials()` around the exchange; this task
extends that same sequence rather than replacing it.

Read `test/cli.test.ts`'s existing `google-login` tests (added when the base command was built)
before writing new ones, and match their exact structure (in particular, note the file already
defines a `withoutGoogleOAuthEnv()` helper and a `run()` helper with an `env` parameter — reuse
both, don't redefine them).

- [ ] **Step 1: Write the failing test**

Add to `test/cli.test.ts`, near the existing `google-login` tests:

```ts
test("google-login --create still requires a client id and secret", async () => {
  const exitCode = await runCli(["google-login", "--create"], withoutGoogleOAuthEnv({}));
  expect(exitCode).toBe(2);
});
```

(Match whatever the existing "google-login requires a client id and secret" test's exact call
shape is — the point of this test is only that `--create` doesn't bypass the existing
client-id/secret validation, which happens before any Picker/create branching.)

- [ ] **Step 2: Run test to verify it passes already, then implement the real change**

Run: `bun test test/cli.test.ts`
This particular test should already PASS against the current code (the client-id/secret check runs
before anything `--create`-specific), since `--create` isn't parsed as a distinct path yet — it
simply falls through to the exact same validation. That's expected; it's here to pin the ordering,
not to catch a bug. Proceed to the implementation step regardless.

- [ ] **Step 3: Implement**

In `bin/shorthand-notes.ts`, add `"--create"` to the `KNOWN_FLAGS` set (it takes no value, so it
only needs to be recognized as a flag, not parsed via `argumentValue`).

Replace the current `runGoogleLogin` body (from the `redirect`/`documentId` handling onward) with:

```ts
async function runGoogleLogin(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const clientId = argumentValue(args, "--client-id") ?? environment.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = argumentValue(args, "--client-secret") ?? environment.GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) {
    return usage("google-login requires --client-id/--client-secret or GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET.");
  }
  const createMode = args.includes("--create");
  const port = Number(argumentValue(args, "--port") ?? "0") || 8721;
  const { OAuth2Client } = await import("google-auth-library");
  const client = new OAuth2Client({ clientId, clientSecret });
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { generatePkceChallenge, buildAuthorizationUrl, listenForRedirect, exchangeCode } = await import("../src/google/oauth.js");
  const { readCredentials, writeCredentials, mergeCredentials } = await import("../src/google/file-token-provider.js");
  const { GOOGLE_DOCS_SCOPE } = await import("../src/google/docs-sink.js");

  const { codeVerifier, codeChallenge } = await generatePkceChallenge(client);
  const authorizationUrl = buildAuthorizationUrl({ clientId, redirectUri, codeChallenge, scope: GOOGLE_DOCS_SCOPE, usePicker: !createMode });
  console.log(`Opening your browser to authorize Shorthand:\n${authorizationUrl}`);
  await openInBrowser(authorizationUrl, environment);

  const redirect = await listenForRedirect(port);
  const { refreshToken } = await exchangeCode(client, redirect.code, codeVerifier, redirectUri);
  // exchangeCode's returned refreshToken is what every downstream Drive/Docs
  // call in this function authenticates with — set it explicitly rather than
  // relying on getToken() having already done so as a side effect, so this
  // doesn't depend on an unverified library internal.
  client.setCredentials({ refresh_token: refreshToken });
  const existingCredentials = await readCredentials();

  let documentId: string;
  let folderId: string | undefined;
  if (createMode) {
    const { ensureContainerDoc } = await import("../src/google/container-doc.js");
    const created = await ensureContainerDoc(client, {
      folderId: existingCredentials?.folderId,
      documentId: existingCredentials?.documentId,
    });
    documentId = created.documentId;
    folderId = created.folderId;
  } else {
    const picked = redirect.pickedFileIds[0];
    if (picked === undefined) {
      console.error("No document was picked. Re-run google-login and choose a Google Doc.");
      return 1;
    }
    documentId = picked;
  }

  await writeCredentials(mergeCredentials(existingCredentials, {
    refreshToken,
    documentId,
    ...(folderId === undefined ? {} : { folderId }),
  }));
  console.log(createMode
    ? `Google account connected. Created (or reused) folder ${folderId} and container doc ${documentId}.`
    : `Google account connected. Target document: ${documentId}.`);
  // `enhance` does not yet accept a --sink flag or otherwise construct a
  // GoogleDocsNoteSink; that integration is a later, not-yet-built increment.
  // Don't imply it already works.
  console.log("Credentials saved. Google Docs sink support is not yet wired into `shorthand-notes enhance`.");
  return 0;
}
```

(The function's first four lines — `clientId`/`clientSecret` resolution and the usage-error
return — are unchanged from the current code; shown here only for context. Everything from
`const createMode = ...` onward is new or restructured.)

- [ ] **Step 4: Run tests, typecheck, and build**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS. The `build` step matters here specifically because it re-bundles
`bin/shorthand-notes.ts`'s new dynamic import of `../src/google/container-doc.js`.

- [ ] **Step 5: Commit**

```bash
git add bin/shorthand-notes.ts test/cli.test.ts
git commit -m "feat: add google-login --create for an app-owned folder and container doc"
```

---

### Task 5: Fix `FileTokenProvider`'s token caching

**Files:**
- Modify: `src/google/file-token-provider.ts`
- Test: `test/google-file-token-provider.test.ts`

**Interfaces:**
- No change to `FileTokenProvider`'s public constructor options or `TokenProvider` interface.
  `defaultRefresher` (currently private to the module) gains an internal-only optional third
  parameter for testing; production callers are unaffected.

**Context:** Spec's "Follow-up fix: token caching". `google-auth-library`'s `OAuth2Client` already
tracks `credentials.expiry_date` and skips its own network refresh when a cached, non-expiring
`access_token` is present (`getAccessToken()` checks `isTokenExpiring()` before refreshing) — but
`defaultRefresher` constructs a **new** `OAuth2Client` inside the per-call closure it returns, so
there is never anything for that caching to hold onto between calls. The fix is to construct the
client once and reuse it.

**Before writing the fix, verify this claim against the actually-installed `google-auth-library`
version's real source** (`node_modules/google-auth-library/build/src/auth/oauth2client.js` —
`getAccessToken`/`isTokenExpiring`/`refreshAccessTokenAsync`), not just assumed semantics. This
project has already been burned once in this exact area (the `getRequestHeaders`-was-dead-code
discovery during the original sink's auth wiring, documented in `docs-client.ts`'s own comments) —
confirm the mechanism actually works as described before relying on it, and note in the commit
message (or a code comment, if the confirmation reveals something non-obvious) what you actually
found, per this repo's "record the actual reason" convention.

- [ ] **Step 1: Write the failing test**

Add to `test/google-file-token-provider.test.ts`:

```ts
describe("defaultRefresher's client caching", () => {
  test("constructs the underlying client once, not once per call", async () => {
    let clientsCreated = 0;
    const refresher = defaultRefresher("client-id", "client-secret", () => {
      clientsCreated += 1;
      let accessToken = "token-from-first-refresh";
      return {
        setCredentials: () => {},
        getAccessToken: async () => ({ token: accessToken }),
      };
    });
    const first = await refresher("refresh-token-1");
    const second = await refresher("refresh-token-1");
    expect(first).toEqual({ ok: true, token: "token-from-first-refresh" });
    expect(second).toEqual({ ok: true, token: "token-from-first-refresh" });
    expect(clientsCreated).toBe(1);
  });
});
```

This requires exporting `defaultRefresher` (it's currently declared without `export`) and adding
the injectable-client-factory parameter in Step 3 below — both are test-support changes only;
production behavior (called from `FileTokenProvider`'s constructor with only `clientId`/
`clientSecret`) is unaffected since the new parameter defaults to constructing a real
`OAuth2Client`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/google-file-token-provider.test.ts`
Expected: FAIL — `defaultRefresher` is not exported, and/or doesn't accept a third parameter yet.

- [ ] **Step 3: Implement**

In `src/google/file-token-provider.ts`, change:

```ts
function defaultRefresher(clientId: string, clientSecret: string): (refreshToken: string) => Promise<TokenResult> {
  return async (refreshToken: string): Promise<TokenResult> => {
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials({ refresh_token: refreshToken });
    const { token } = await client.getAccessToken();
    if (token === null || token === undefined) {
      return { ok: false, error: tokenError("transport", "Token refresh returned no access token") };
    }
    return { ok: true, token };
  };
}
```

to:

```ts
type RefreshableClient = Pick<OAuth2Client, "setCredentials" | "getAccessToken">;

/**
 * Constructs the OAuth2Client once and reuses it across calls, rather than
 * once per call — otherwise there is nothing for the library's own
 * expiry_date-based caching (OAuth2Client.getAccessToken() -> isTokenExpiring())
 * to hold onto between calls, and every call pays a full token-endpoint
 * round-trip even when the previous access token is still valid.
 */
export function defaultRefresher(
  clientId: string,
  clientSecret: string,
  createClient: () => RefreshableClient = () => new OAuth2Client({ clientId, clientSecret }),
): (refreshToken: string) => Promise<TokenResult> {
  let client: RefreshableClient | undefined;
  return async (refreshToken: string): Promise<TokenResult> => {
    if (client === undefined) {
      client = createClient();
      client.setCredentials({ refresh_token: refreshToken });
    }
    const { token } = await client.getAccessToken();
    if (token === null || token === undefined) {
      return { ok: false, error: tokenError("transport", "Token refresh returned no access token") };
    }
    return { ok: true, token };
  };
}
```

Update the one call site (`FileTokenProvider`'s constructor) if the exported signature requires
it — it currently reads `defaultRefresher(options.clientId, options.clientSecret)`, which still
matches the new signature (the third parameter is optional), so no change should be needed there;
confirm this after making the change above.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/google-file-token-provider.test.ts && bun run typecheck`
Expected: PASS, including every pre-existing test in the file unmodified — in particular the
existing `FileTokenProvider.getAccessToken` tests that inject `refreshAccessToken` (a completely
separate seam from `defaultRefresher`) must still pass exactly as written, proving this change
doesn't touch that path at all.

- [ ] **Step 5: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/google/file-token-provider.ts test/google-file-token-provider.test.ts
git commit -m "fix: stop constructing a fresh OAuth2Client on every token refresh"
```

---

## Self-Review Notes

- **Spec coverage:** "Phase 1c addendum" → Tasks 1-4. "Follow-up fix: token caching" → Task 5. Both
  sections' every concrete requirement (idempotent reuse of folder/doc IDs, `drive.file`-only
  scope, `documents.create` having no `parents` field, holding one `OAuth2Client` instance) has a
  corresponding task and test.
- **Type consistency:** `GoogleCredentials.folderId` (Task 1) is the exact field `ensureContainerDoc`
  (Task 3) produces and `runGoogleLogin` (Task 4) threads through `mergeCredentials`. `usePicker`
  (Task 2) is the exact option name Task 4's `buildAuthorizationUrl` call uses.
- **No new scope surface:** confirmed no task adds a Google auth scope string anywhere other than
  reusing the existing `GOOGLE_DOCS_SCOPE` import — `test/google-scope-guard.test.ts` (already
  shipped, unmodified by this plan) continues to guard this across the whole `src/`/`bin/` tree.
