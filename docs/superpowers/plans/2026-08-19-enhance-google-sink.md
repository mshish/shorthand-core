# Reachable GoogleDocsNoteSink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GoogleDocsNoteSink` constructible and selectable from the `shorthand-notes` CLI, by minting/persisting a per-meeting Google Docs tab and adding a `--sink` flag to `capture`/`enhance`.

**Architecture:** Two additive core modules — `addDocumentTab` on `GoogleDocsApi`/`GoogleApiDocsClient`, and a new `resolveGoogleDocsSink()` in `src/google/capture-sink.ts` that mints-or-reuses a tab keyed by a hash of the note path and constructs the sink — plus a thin `--sink markdown|google` wiring change in `bin/shorthand-notes.ts`. No changes to `GoogleDocsNoteSink`, `EnhanceRunner`, or the credentials file contract.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck`), `googleapis` (`docs_v1`), Node built-ins (`node:crypto`, `node:fs/promises`, `node:path`).

**Spec:** `docs/superpowers/specs/2026-08-19-enhance-google-sink-design.md`

## Global Constraints

- **Core never names `shorthand-config`** in any user-facing message — not even to tell the user what to run. Follow the existing precedent at `src/google/file-token-provider.ts:64` ("connect your Google account, then retry", no app name).
- **The capture-state file (`captures/<id>.json`) is plain camelCase** (`documentId`, `tabId`, `createdAt`) — it has one writer, one language, unlike the cross-language ADC credentials file.
- **`captureId` = SHA-256 hex of the resolved note path, lowercased on `win32` only** (NTFS is case-insensitive but case-preserving; other platforms are case-sensitive and must not be lowercased).
- **A corrupt/unparseable capture-state file is not an error** — treat it exactly like a missing file (mint fresh) and never let it surface as `{ok:false}`.
- **`addDocumentTab` is its own method**, making its own `#documents.batchUpdate` call — it must not be implemented by calling the existing public `batchUpdate()` method, which discards the `replies[]` payload it needs.
- **`folder_id` is never read** by any code in this plan. Only `document_id` is used.
- Every task must leave `bun run typecheck` and `bun test` green before its commit.

---

### Task 1: `addDocumentTab` on `GoogleDocsApi`

**Files:**
- Modify: `src/google/docs-client.ts`
- Modify: `test/google-docs-client.test.ts`
- Modify: `test/google-docs-sink-unit.test.ts` (fix `fakeApi()` so it still satisfies `GoogleDocsApi`)
- Modify: `test/google-docs-sink.test.ts` (fix `FakeDocsApi` so it still satisfies `GoogleDocsApi`)

**Interfaces:**
- Produces: `GoogleDocsApi.addDocumentTab(documentId: string, title: string): Promise<DocsApiResult<{ tabId: string }>>`, implemented on `GoogleApiDocsClient`. Task 2 calls this.

- [ ] **Step 1: Write the failing tests in `test/google-docs-client.test.ts`**

Add inside the existing `describe("GoogleApiDocsClient", ...)` block:

```ts
  test("addDocumentTab returns the new tab's id from the batchUpdate reply", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async (request: unknown) => {
          const body = (request as { requestBody: { requests: Array<{ addDocumentTab?: { tabProperties?: { title?: string } } }> } }).requestBody;
          expect(body.requests).toEqual([{ addDocumentTab: { tabProperties: { title: "Meeting" } } }]);
          return { data: { replies: [{ addDocumentTab: { tabProperties: { tabId: "new-tab-1" } } }] } };
        },
      },
    } as never);
    const result = await client.addDocumentTab("doc1", "Meeting");
    expect(result).toEqual({ ok: true, value: { tabId: "new-tab-1" } });
  });

  test("addDocumentTab maps a batchUpdate failure the same way batchUpdate itself does", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async () => { throw gaxiosError(403); },
      },
    } as never);
    const result = await client.addDocumentTab("doc1", "Meeting");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.httpStatus).toBe(403);
  });

  test("addDocumentTab reports an error when the response carries no tabId", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async () => ({ data: { replies: [{ addDocumentTab: {} }] } }),
      },
    } as never);
    const result = await client.addDocumentTab("doc1", "Meeting");
    expect(result).toEqual({
      ok: false,
      error: { httpStatus: 0, message: "Docs API response carried no tabId for the new tab", cause: expect.anything() },
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/google-docs-client.test.ts`
Expected: FAIL — `client.addDocumentTab is not a function` (or a TypeScript error if run through `bun run typecheck` first; either failure mode confirms the method doesn't exist yet).

- [ ] **Step 3: Add `addDocumentTab` to the `GoogleDocsApi` interface**

In `src/google/docs-client.ts`, extend the interface (around line 18-25):

```ts
export interface GoogleDocsApi {
  getDocument(documentId: string): Promise<DocsApiResult<GetDocumentValue>>;
  batchUpdate(
    documentId: string,
    requests: readonly docs_v1.Schema$Request[],
    targetRevisionId?: string,
  ): Promise<DocsApiResult<BatchUpdateValue>>;
  addDocumentTab(documentId: string, title: string): Promise<DocsApiResult<{ tabId: string }>>;
}
```

- [ ] **Step 4: Implement it on `GoogleApiDocsClient`**

Add this method to the class (after the existing `batchUpdate` method, before the closing brace at line 129):

```ts
  async addDocumentTab(documentId: string, title: string): Promise<DocsApiResult<{ tabId: string }>> {
    try {
      const response = await this.#documents.batchUpdate({
        documentId,
        requestBody: { requests: [{ addDocumentTab: { tabProperties: { title } } }] },
      });
      const tabId = response.data.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
      if (tabId === undefined || tabId === null || tabId.length === 0) {
        return {
          ok: false,
          error: { httpStatus: 0, message: "Docs API response carried no tabId for the new tab", cause: response.data },
        };
      }
      return { ok: true, value: { tabId } };
    } catch (error) {
      return { ok: false, error: toDocsApiError(error) };
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/google-docs-client.test.ts`
Expected: PASS (all tests, including the three new ones).

- [ ] **Step 6: Fix the two existing fakes so `bun run typecheck` still passes**

In `test/google-docs-sink-unit.test.ts`, `fakeApi()` (lines 5-14), add a default:

```ts
function fakeApi(overrides: Partial<GoogleDocsApi> = {}): GoogleDocsApi {
  return {
    getDocument: async (): Promise<DocsApiResult<GetDocumentValue>> => ({
      ok: true,
      value: { revisionId: "rev1", tabs: [{ tabId: "owned", bodyEndIndex: 1, paragraphs: [], childTabs: [] }] },
    }),
    batchUpdate: async (): Promise<DocsApiResult<BatchUpdateValue>> => ({ ok: true, value: { revisionId: "rev2" } }),
    addDocumentTab: async () => ({ ok: true, value: { tabId: "unused-tab" } }),
    ...overrides,
  };
}
```

In `test/google-docs-sink.test.ts`, `class FakeDocsApi implements GoogleDocsApi` (starting line 16), add a method alongside `getDocument`/`batchUpdate`:

```ts
  async addDocumentTab(): Promise<DocsApiResult<{ tabId: string }>> {
    return { ok: true, value: { tabId: "unused-tab" } };
  }
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/google/docs-client.ts test/google-docs-client.test.ts test/google-docs-sink-unit.test.ts test/google-docs-sink.test.ts
git commit -m "feat: add addDocumentTab to GoogleDocsApi"
```

---

### Task 2: `resolveGoogleDocsSink()` — mint-or-reuse the per-capture tab

**Files:**
- Create: `src/google/capture-sink.ts`
- Test: `test/google-capture-sink.test.ts`

**Interfaces:**
- Consumes: `GoogleDocsApi` and `GoogleApiDocsClient` from `./docs-client.js` (Task 1); `GoogleDocsNoteSink` from `./docs-sink.js`; `FileTokenProvider`, `readCredentials`, `credentialsPath` from `./file-token-provider.js`; `shorthandConfigDirectory` from `../config.js`.
- Produces:
  ```ts
  export type ResolveGoogleSinkOptions = Readonly<{
    credentialsPath?: string;
    capturesDirectory?: string;
    api?: GoogleDocsApi;
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
  Task 3 exports this from `shorthand-core/google`; Task 4 calls it from `bin/shorthand-notes.ts`.

- [ ] **Step 1: Write the failing tests in `test/google-capture-sink.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGoogleDocsSink } from "../src/google/capture-sink.js";
import type { BatchUpdateValue, DocsApiResult, GetDocumentValue, GoogleDocsApi } from "../src/google/docs-client.js";
import type { GoogleCredentials } from "../src/google/file-token-provider.js";

const VALID: GoogleCredentials = {
  type: "authorized_user",
  client_id: "1234567890-test.apps.googleusercontent.com",
  client_secret: "test-client-secret",
  refresh_token: "rt-1",
  document_id: "doc-1",
};

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "google-capture-sink-"));
}

async function writeCredentials(directory: string, value: unknown): Promise<string> {
  const path = join(directory, "google-credentials.json");
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  return path;
}

function fakeApi(overrides: Partial<GoogleDocsApi> = {}): GoogleDocsApi {
  return {
    getDocument: async (): Promise<DocsApiResult<GetDocumentValue>> => ({ ok: true, value: { revisionId: "r1", tabs: [] } }),
    batchUpdate: async (): Promise<DocsApiResult<BatchUpdateValue>> => ({ ok: true, value: { revisionId: "r2" } }),
    addDocumentTab: async () => ({ ok: true, value: { tabId: "minted-tab" } }),
    ...overrides,
  };
}

async function onlyStateFile(capturesDirectory: string): Promise<{ path: string; contents: Record<string, unknown> }> {
  const entries = await readdir(capturesDirectory);
  expect(entries.length).toBe(1);
  const path = join(capturesDirectory, entries[0]!);
  return { path, contents: JSON.parse(await readFile(path, "utf8")) };
}

describe("resolveGoogleDocsSink", () => {
  test("mints a tab and writes the state file on first run", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    let mintedTitle: string | undefined;
    const api = fakeApi({
      addDocumentTab: async (documentId, title) => {
        expect(documentId).toBe("doc-1");
        mintedTitle = title;
        return { ok: true, value: { tabId: "fresh-tab" } };
      },
    });
    const result = await resolveGoogleDocsSink(join(directory, "meeting.md"), {}, { credentialsPath, capturesDirectory, api });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sink.describe).toBe("Google Doc doc-1 (tab fresh-tab)");
    expect(mintedTitle).toBe("meeting");
    const state = await onlyStateFile(capturesDirectory);
    expect(state.contents.documentId).toBe("doc-1");
    expect(state.contents.tabId).toBe("fresh-tab");
    expect(typeof state.contents.createdAt).toBe("string");
  });

  test("reuses the persisted tabId on a second call for the same note (crash-resume)", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    let mintCount = 0;
    const api = fakeApi({ addDocumentTab: async () => { mintCount += 1; return { ok: true, value: { tabId: `tab-${mintCount}` } }; } });
    const notePath = join(directory, "meeting.md");
    const first = await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    const second = await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    expect(first.ok && second.ok).toBe(true);
    expect(mintCount).toBe(1);
    if (first.ok && second.ok) expect(second.sink.describe).toBe(first.sink.describe);
  });

  test("re-mints when the credentials file's document_id has changed since the last run", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    let mintCount = 0;
    const api = fakeApi({ addDocumentTab: async () => { mintCount += 1; return { ok: true, value: { tabId: `tab-${mintCount}` } }; } });
    const notePath = join(directory, "meeting.md");
    await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    await writeCredentials(directory, { ...VALID, document_id: "doc-2" });
    const second = await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    expect(mintCount).toBe(2);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.sink.describe).toBe("Google Doc doc-2 (tab tab-2)");
    const state = await onlyStateFile(capturesDirectory);
    expect(state.contents.documentId).toBe("doc-2");
  });

  test("a corrupt state file is not an error — resolves ok with a freshly minted tab", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    let mintCount = 0;
    const api = fakeApi({ addDocumentTab: async () => { mintCount += 1; return { ok: true, value: { tabId: `tab-${mintCount}` } }; } });
    const notePath = join(directory, "meeting.md");
    await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    const { path } = await onlyStateFile(capturesDirectory);
    await writeFile(path, "{not valid json", "utf8");
    const second = await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
    expect(second.ok).toBe(true);
    expect(mintCount).toBe(2);
  });

  test("fails clearly, without naming any consumer app, when credentials are unreadable", async () => {
    const directory = await scratchDir();
    const capturesDirectory = join(directory, "captures");
    const result = await resolveGoogleDocsSink(join(directory, "meeting.md"), {}, {
      credentialsPath: join(directory, "does-not-exist.json"),
      capturesDirectory,
      api: fakeApi(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("connect your Google account");
    expect(result.message).not.toContain("shorthand-config");
  });

  test("fails clearly, without naming any consumer app, when document_id is absent", async () => {
    const directory = await scratchDir();
    const { document_id: _omit, ...withoutDocument } = VALID;
    const credentialsPath = await writeCredentials(directory, withoutDocument);
    const capturesDirectory = join(directory, "captures");
    const result = await resolveGoogleDocsSink(join(directory, "meeting.md"), {}, { credentialsPath, capturesDirectory, api: fakeApi() });
    expect(result).toEqual({
      ok: false,
      message: "No Google Doc selected; connect your Google account and choose a target document, then retry.",
    });
  });

  test("fails clearly when minting the tab itself fails", async () => {
    const directory = await scratchDir();
    const credentialsPath = await writeCredentials(directory, VALID);
    const capturesDirectory = join(directory, "captures");
    const api = fakeApi({ addDocumentTab: async () => ({ ok: false, error: { httpStatus: 403, message: "forbidden" } }) });
    const result = await resolveGoogleDocsSink(join(directory, "meeting.md"), {}, { credentialsPath, capturesDirectory, api });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("forbidden");
  });

  test.skipIf(process.platform !== "win32")(
    "on Windows, paths differing only by case reach the same captureId",
    async () => {
      const directory = await scratchDir();
      const credentialsPath = await writeCredentials(directory, VALID);
      const capturesDirectory = join(directory, "captures");
      let mintCount = 0;
      const api = fakeApi({ addDocumentTab: async () => { mintCount += 1; return { ok: true, value: { tabId: `tab-${mintCount}` } }; } });
      const notePath = join(directory, "Meeting.md");
      await resolveGoogleDocsSink(notePath, {}, { credentialsPath, capturesDirectory, api });
      await resolveGoogleDocsSink(notePath.toUpperCase(), {}, { credentialsPath, capturesDirectory, api });
      expect(mintCount).toBe(1);
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/google-capture-sink.test.ts`
Expected: FAIL — `Cannot find module '../src/google/capture-sink.js'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `src/google/capture-sink.ts`**

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { shorthandConfigDirectory } from "../config.js";
import { GoogleApiDocsClient, type GoogleDocsApi } from "./docs-client.js";
import { GoogleDocsNoteSink } from "./docs-sink.js";
import { credentialsPath as defaultCredentialsPath, FileTokenProvider, readCredentials } from "./file-token-provider.js";

/**
 * Where core reaches `GoogleDocsNoteSink` from: mints a tab via `addDocumentTab`
 * on first use of a note, persists it keyed by a hash of the note's path, and
 * reuses it on every later call for the same note — until the credentials
 * file's `document_id` changes, at which point a fresh tab is minted in the
 * new target document. See docs/superpowers/specs/2026-08-19-enhance-google-sink-design.md.
 */

export type ResolveGoogleSinkOptions = Readonly<{
  credentialsPath?: string;
  capturesDirectory?: string;
  /** Test seam only; production always builds a GoogleApiDocsClient. */
  api?: GoogleDocsApi;
}>;

export type ResolveGoogleSinkResult =
  | Readonly<{ ok: true; sink: GoogleDocsNoteSink }>
  | Readonly<{ ok: false; message: string }>;

type CaptureState = Readonly<{ documentId: string; tabId: string; createdAt: string }>;

export async function resolveGoogleDocsSink(
  notePath: string,
  environment: NodeJS.ProcessEnv,
  options: ResolveGoogleSinkOptions = {},
): Promise<ResolveGoogleSinkResult> {
  const credsPath = options.credentialsPath ?? defaultCredentialsPath(environment);
  const credentials = await readCredentials(credsPath);
  if (!credentials.ok) return { ok: false, message: credentials.message };

  const documentId = credentials.value.document_id;
  if (documentId === undefined) {
    return { ok: false, message: "No Google Doc selected; connect your Google account and choose a target document, then retry." };
  }

  const capturesDirectory = options.capturesDirectory ?? join(shorthandConfigDirectory(environment), "captures");
  const statePath = join(capturesDirectory, `${captureIdFor(notePath)}.json`);
  const api = options.api ?? new GoogleApiDocsClient(new FileTokenProvider({ credentialsPath: credsPath }));

  let tabId = await reusableTabId(statePath, documentId);
  if (tabId === undefined) {
    const title = basename(notePath, extname(notePath));
    const minted = await api.addDocumentTab(documentId, title);
    if (!minted.ok) return { ok: false, message: `Could not create a Google Docs tab: ${minted.error.message}` };
    tabId = minted.value.tabId;
    const state: CaptureState = { documentId, tabId, createdAt: new Date().toISOString() };
    await mkdir(capturesDirectory, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  return { ok: true, sink: new GoogleDocsNoteSink({ documentId, tabId, api }) };
}

/**
 * NTFS is case-insensitive but case-preserving, so two invocations of the
 * same note differing only by path case must reach the same id on Windows —
 * otherwise a crash-resume with a differently-cased path would silently mint
 * a second tab. Other platforms are case-sensitive; lowercasing there would
 * wrongly collide two different files.
 */
function captureIdFor(notePath: string): string {
  const resolved = resolve(notePath);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * A missing or unparseable state file is a cache miss, not a failure — this
 * always resolves to `undefined` rather than throwing or rejecting, so a
 * corrupt file (this is a disposable cache, not authoritative data) never
 * surfaces as an error to the caller.
 */
async function reusableTabId(statePath: string, documentId: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CaptureState>;
    if (parsed.documentId === documentId && typeof parsed.tabId === "string" && parsed.tabId.length > 0) {
      return parsed.tabId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/google-capture-sink.test.ts`
Expected: PASS (all cases; the Windows-only case test either passes or is reported skipped depending on platform).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/google/capture-sink.ts test/google-capture-sink.test.ts
git commit -m "feat: resolve a Google Docs sink by minting or reusing a per-capture tab"
```

---

### Task 3: Export from `shorthand-core/google`, document in CONTRACT.md

**Files:**
- Modify: `src/google.ts`
- Modify: `docs/CONTRACT.md`

**Interfaces:**
- Consumes: `resolveGoogleDocsSink`, `ResolveGoogleSinkOptions`, `ResolveGoogleSinkResult` from `./google/capture-sink.js` (Task 2).
- Produces: the same three names, now importable as `import { resolveGoogleDocsSink } from "shorthand-core/google"`. Task 4 imports this.

- [ ] **Step 1: Add the export**

In `src/google.ts`, after the existing `FileTokenProvider`/`credentialsPath`/`readCredentials` export block (end of file):

```ts
export { resolveGoogleDocsSink } from "./google/capture-sink.js";
export type { ResolveGoogleSinkOptions, ResolveGoogleSinkResult } from "./google/capture-sink.js";
```

- [ ] **Step 2: Update `docs/CONTRACT.md`'s export table**

Replace line 29 (the `shorthand-core/google` row):

```markdown
| `shorthand-core/google` | The Google Docs sink and the pieces it needs: `GoogleDocsNoteSink`, `GOOGLE_DOCS_SCOPE`, `GoogleApiDocsClient` and its API types, the credentials reader — `FileTokenProvider`, `credentialsPath`, `readCredentials`, `GoogleCredentials`, `CredentialsReadResult`, `FileTokenProviderOptions` — and `resolveGoogleDocsSink`/`ResolveGoogleSinkOptions`/`ResolveGoogleSinkResult`, which mints or reuses a per-capture tab and constructs the sink | Google Docs consumers only. **A Markdown or other API sink must not import this.** Core reads the credentials file and never writes it; see §5.4 |
```

- [ ] **Step 3: Verify the export resolves and typecheck passes**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun -e "import('shorthand-core/google').then(m => console.log(typeof m.resolveGoogleDocsSink))"`
Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add src/google.ts docs/CONTRACT.md
git commit -m "docs: export resolveGoogleDocsSink from shorthand-core/google"
```

---

### Task 4: CLI wiring — `--sink markdown|google`

**Files:**
- Modify: `bin/shorthand-notes.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**
- Consumes: `resolveGoogleDocsSink` from `"shorthand-core/google"` (Task 3); `type NoteSink` from `"shorthand-core"`.
- Produces: `--sink markdown|google` flag on `capture` and `enhance`; `createEnhanceRunner` becomes `async`, returning `{ok:true, runner: EnhanceRunner} | {ok:false, message: string}`.

- [ ] **Step 1: Write the failing tests in `test/cli.test.ts`**

Add inside `describe("shorthand-notes CLI", ...)`, near the other `enhance`/`capture` tests:

```ts
  test("enhance rejects an invalid --sink value", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-sink-invalid-test-"));
    scratchDirectories.push(vault);
    await writeFile(join(vault, "meeting.md"), "# Meeting\n", "utf8");
    await writeFile(join(vault, "transcript.md"), "me: hi", "utf8");
    const result = await run(join(process.cwd(), "bin", "shorthand-notes.ts"), [
      "enhance", "--vault", vault, "--note", "meeting.md", "--transcript", "transcript.md", "--sink", "notion",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--sink must be markdown or google.");
  });

  test("enhance --sink google fails clearly, without naming any consumer app, when no Google credentials are configured", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-sink-google-nocreds-test-"));
    scratchDirectories.push(vault);
    const configDirectory = await mkdtemp(join(tmpdir(), ".cli-sink-google-config-"));
    scratchDirectories.push(configDirectory);
    await writeFile(join(vault, "meeting.md"), "# Meeting\n", "utf8");
    await writeFile(join(vault, "transcript.md"), "me: hi", "utf8");
    const result = await run(
      join(process.cwd(), "bin", "shorthand-notes.ts"),
      ["enhance", "--vault", vault, "--note", "meeting.md", "--transcript", "transcript.md", "--sink", "google"],
      withoutGoogleOAuthEnv({ APPDATA: configDirectory }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("connect your Google account");
    expect(result.stderr).not.toContain("shorthand-config");
  });

  test("capture --sink google fails before the recording stream starts when no Google credentials are configured", async () => {
    const vault = await mkdtemp(join(tmpdir(), ".cli-capture-sink-nocreds-test-"));
    scratchDirectories.push(vault);
    const configDirectory = await mkdtemp(join(tmpdir(), ".cli-capture-sink-config-"));
    scratchDirectories.push(configDirectory);
    await writeFile(join(vault, "meeting.md"), "# Meeting\n\nUser-owned notes.\n", "utf8");
    const entry = join(process.cwd(), "bin", "shorthand-notes.ts");
    const fixture = join(process.cwd(), "test", "fixtures", "fake-stream.mjs");
    const result = await run(
      entry,
      ["capture", "--vault", vault, "--note", "meeting.md", "--fake-stream", fixture, "--no-reconnect", "--enhance", "--sink", "google"],
      withoutGoogleOAuthEnv({ APPDATA: configDirectory }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No Google credentials");
    expect(result.stdout).not.toContain("Sidecar written");
    await expect(readFile(join(vault, "transcript.md"), "utf8")).rejects.toThrow();
  }, 10_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/cli.test.ts`
Expected: FAIL — the invalid-`--sink` test fails because `--sink` is currently accepted and ignored (exit code 0, not 2); the two `google` tests fail because `--sink` has no effect yet (both run against `MarkdownNoteSink` and either succeed or fail for unrelated reasons, not with the expected message).

- [ ] **Step 3: Add `--sink` to `KNOWN_FLAGS` and the usage string**

In `bin/shorthand-notes.ts`, update `KNOWN_FLAGS` (around line 49-53):

```ts
const KNOWN_FLAGS = new Set([
  "--note", "--vault", "--sidecar", "--shorthand", "--fake-stream", "--no-reconnect",
  "--title", "--json", "--expect-hash", "--force", "--enhance", "--transcript",
  "--tier", "--dry-run", "--agent-stub", "--claude", "--sink",
]);
```

Update the `usage()` message (around line 38-41) so both `capture` and `enhance` lines mention `[--sink markdown|google]` (insert it next to `--tier`/`--enhance` in each line, matching the existing style of that string).

- [ ] **Step 4: Add the imports `createEnhanceRunner` needs**

In `bin/shorthand-notes.ts`, add `type NoteSink` to the existing `"shorthand-core"` import block (around line 13-28), and add a new import line for the Google subpath right after the existing `"shorthand-core/markdown"` import:

```ts
import { resolveGoogleDocsSink } from "shorthand-core/google";
```

- [ ] **Step 5: Make `createEnhanceRunner` async and sink-aware**

Replace the whole function (lines 314-341) with:

```ts
type CreateEnhanceRunnerResult =
  | Readonly<{ ok: true; runner: EnhanceRunner }>
  | Readonly<{ ok: false; message: string }>;

async function createEnhanceRunner(
  note: string,
  vault: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  dryRun: boolean,
): Promise<CreateEnhanceRunnerResult> {
  const sinkArg = argumentValue(args, "--sink") ?? "markdown";
  if (sinkArg !== "markdown" && sinkArg !== "google") {
    return { ok: false, message: "--sink must be markdown or google." };
  }
  let sink: NoteSink;
  if (sinkArg === "google") {
    const resolved = await resolveGoogleDocsSink(note, environment);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    sink = resolved.sink;
  } else {
    sink = new MarkdownNoteSink({ notePath: note, vaultRoot: vault });
  }
  const stubPath = argumentValue(args, "--agent-stub") ?? environment.HANDY_NOTES_AGENT_STUB;
  const agent: AgentClient = stubPath === undefined
    ? new ClaudeAgentClient()
    : new ExecutableAgentStub(resolveFrom(process.cwd(), stubPath));
  const claudeOverride = argumentValue(args, "--claude");
  const claudeExecutable = detectClaudeExecutable(claudeOverride, environment);
  return {
    ok: true,
    runner: new EnhanceRunner({
      sink,
      agent,
      minNewChars: DEFAULT_CONFIG.thresholds.enhancementNewCharacters,
      minIntervalMs: DEFAULT_CONFIG.thresholds.enhancementIntervalMs,
      maxDurationMs: environmentNumber(environment.HANDY_NOTES_MAX_DURATION_MS, DEFAULT_CONFIG.enhancement.maxDurationMs),
      timeoutMs: environmentNumber(environment.HANDY_NOTES_AGENT_TIMEOUT_MS, DEFAULT_CONFIG.enhancement.timeoutMs),
      maxTurns: DEFAULT_CONFIG.enhancement.maxTurns,
      dryRun,
      ...(claudeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: claudeExecutable }),
      onStatus: ({ message }) => console.error(message),
    }),
  };
}
```

- [ ] **Step 6: Update `runEnhance` to await and handle the result**

In `runEnhance` (around line 301-304), replace:

```ts
  const dryRun = args.includes("--dry-run");
  const runner = createEnhanceRunner(note, vault, args, environment, dryRun);
  runner.appendTranscript(transcriptText);
```

with:

```ts
  const dryRun = args.includes("--dry-run");
  const resolved = await createEnhanceRunner(note, vault, args, environment, dryRun);
  if (!resolved.ok) {
    console.error(resolved.message);
    return 1;
  }
  const runner = resolved.runner;
  runner.appendTranscript(transcriptText);
```

- [ ] **Step 7: Update `runCapture` to resolve the sink before any recording resources are constructed**

In `runCapture`, replace the existing enhancer construction (currently sitting after `SidecarWriter` construction, around lines 164-166):

```ts
  const enhancer = args.includes("--enhance")
    ? createEnhanceRunner(note, vault, args, environment, false)
    : undefined;
```

Move sink/enhancer resolution to run **before** `const fake = ...` (i.e., immediately after `noteLinked = true;` finishes the note-linking block, before any of `StreamClient`/`TranscriptStore`/`SidecarWriter` are constructed):

```ts
  let enhancer: EnhanceRunner | undefined;
  if (args.includes("--enhance")) {
    const resolved = await createEnhanceRunner(note, vault, args, environment, false);
    if (!resolved.ok) {
      console.error(resolved.message);
      return 1;
    }
    enhancer = resolved.runner;
  }
```

and delete the old `const enhancer = ...` block from its original location — it must appear exactly once, in its new position.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test test/cli.test.ts`
Expected: PASS (all new cases; all pre-existing `capture`/`enhance` cases still pass, since `--sink` defaults to `markdown`, preserving today's behavior).

- [ ] **Step 9: Run the full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: PASS, no regressions.

- [ ] **Step 10: Manual end-to-end check (from the design's Verification section)**

Following the handoff note's "testing unlock": hand-write a credentials file at `credentialsPath()` using your existing refresh token and the OAuth client that issued it, with a real `document_id`. Run:

```bash
bun bin/shorthand-notes.ts capture --note <note.md> --enhance --sink google
```

Confirm a real tab appears in the target Google Doc, and that re-running the same command against the same note reuses it (check `<shorthandConfigDirectory>/captures/*.json` — one file, unchanged `tabId` across runs) rather than creating a second tab.

- [ ] **Step 11: Commit**

```bash
git add bin/shorthand-notes.ts test/cli.test.ts
git commit -m "feat: add --sink markdown|google to capture and enhance"
```

---

## Self-Review

**Spec coverage:**
- Decision 1 (persisted state, capture id, case fix, corrupt-file resilience, orphaned-tab acknowledgment) → Task 2.
- Decision 2 (`addDocumentTab` as its own method) → Task 1.
- Decision 3 (`resolveGoogleDocsSink`, boundary-safe message) → Task 2.
- Decision 4 (`--sink` flag, async `createEnhanceRunner`, fail-fast ordering) → Task 4.
- CONTRACT.md export row → Task 3.
- Testing plan (addDocumentTab unit tests, capture-sink unit tests including the corrected corrupt-file case, CLI validation/error/fail-fast tests) → Tasks 1, 2, 4 respectively.
- Manual end-to-end verification → Task 4, Step 10.

**Placeholder scan:** no TBD/TODO; every step has complete, real code.

**Type consistency:** `ResolveGoogleSinkResult`/`ResolveGoogleSinkOptions` (Task 2) match their use in Task 3's export and Task 4's `createEnhanceRunner`. `GoogleDocsApi.addDocumentTab` (Task 1) matches its call site in Task 2. `CreateEnhanceRunnerResult` (Task 4) matches both `runCapture` and `runEnhance`'s handling of it.
