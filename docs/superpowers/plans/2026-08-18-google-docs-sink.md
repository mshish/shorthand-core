# GoogleDocsNoteSink (phases 1a/1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GoogleDocsNoteSink` (write meeting notes into a tab of an existing Google Doc)
plus its supporting `TokenProvider` port, reference `FileTokenProvider`, and `google-login` CLI
bootstrap — phases 1a (pick an existing Doc via the Picker) and 1b (one tab per meeting) only.

**Architecture:** A new `TokenProvider` port on the root `shorthand-core` entry point (parallel to
`NoteSink`), and a new `shorthand-core/google` subpath entry point (parallel to
`shorthand-core/markdown`) containing `GoogleDocsNoteSink`, a markdown→Docs-requests renderer, a
thin `GoogleDocsApi` adapter over the official `googleapis` client, and the reference
`FileTokenProvider`. `bin/shorthand-notes.ts` gains a `google-login` subcommand that performs the
OAuth+PKCE+Picker consent round-trip using `google-auth-library`. Every network-touching module is
built behind a small injectable interface so all logic below the actual HTTP call is unit-tested
with in-memory fakes — no live network in the test suite.

**Tech Stack:** `googleapis` (official Node client for Docs v1 / the OAuth2Client's HTTP transport)
and `google-auth-library` (PKCE + token exchange/refresh) for everything OAuth- and Docs-API
adjacent — do not hand-roll HTTP calls, PKCE crypto, or token refresh logic these packages already
provide correctly. `marked` for markdown parsing in the renderer — do not hand-roll a markdown
parser. All three are new dependencies; add them with `bun add`, don't pin versions by hand.

**Spec:** `docs/superpowers/specs/2026-08-18-google-docs-sink.md` (status: approved design). This
plan implements phases 1a/1b only, as scoped there. Executors should read the spec's "Verified
technical facts" and "Error mapping" sections directly — this plan does not restate everything, but
every task references the exact spec section it implements.

## Global Constraints

- **Scope invariant:** request only `https://www.googleapis.com/auth/drive.file`, never combined
  with another scope in the same grant. (Spec: "Scope invariant".)
- **Every Docs API request in a `batchUpdate` array must carry an explicit `tabId`.** Assert this
  in code and throw if any request lacks one — omitting it silently targets the first tab. (Spec:
  "write()".)
- **`read()` is exactly one `documents.get?includeTabsContent=true` call.** Never a separate call
  for revision. (Spec: "read()"; `docs/CONTRACT.md` §2.1.)
- **`write()` is exactly one `batchUpdate` call per pass**, containing delete + insert + all style
  requests together. Never split across multiple `batchUpdate` calls. (Spec: "write()".)
- **Concurrency uses `writeControl.targetRevisionId`, never `requiredRevisionId`.** (Spec:
  "Concurrency".)
- **Locate the owned tab by a persisted `tabId` only — never by position or title.** (Spec:
  "read()".)
- **Follow `docs/CONTRACT.md` §4's HTTP→`SinkError`/`SinkWriteResult` mapping table verbatim.**
  Construct errors with the exported `sinkError`/`busySinkError` helpers from `src/note/sink.ts`,
  never hand-written object literals (`exactOptionalPropertyTypes` is `true` in `tsconfig.json`;
  the helpers get this right, hand-written literals routinely don't).
- **Package layout (Spec: "Package layout"):** the `TokenProvider` *port* (interface + error types)
  is exported from the root `shorthand-core` entry point (`src/index.ts`), physically living at
  `src/auth/token-provider.ts` — it is not Google-specific. Everything Google-specific
  (`GoogleDocsNoteSink`, the renderer, the request builder, the Docs API adapter, `FileTokenProvider`,
  the OAuth helpers) lives under `src/google/` and is re-exported from a new `src/google.ts` entry
  point registered as `shorthand-core/google` in `package.json`'s `exports` map — mirroring
  `shorthand-core/markdown` → `src/markdown.ts`.
- **Explicit named re-exports only, never `export *`.** (`docs/CONTRACT.md` §1.)
- **`bin/` may deep-import from `src/`** — it is internal to core, not a consumer.
  (`docs/CONTRACT.md` §6.) `bin/shorthand-notes.ts` should import Google helpers directly from
  `../src/google/...js`, not through the public `shorthand-core/google` subpath.
- **No live network in any test.** Every module that calls Google's HTTP APIs takes its transport
  as an injected dependency (constructor parameter or function parameter) so tests supply an
  in-memory fake. This mirrors `MarkdownNoteSink`'s injectable `readNote`/`write` and
  `writerOptions.fileSystem` seams in `src/note/markdown-sink.ts` / `src/note/writer.ts`.
- **`bun test` and `bun run typecheck` must pass at the end of every task**, not just at the end of
  the plan. Commit after each task. (This repo has no `lint` script in `package.json` — do not
  invent one; `bun run format:check` exists separately if formatting needs checking.)

---

### Task 1: Platform-conventional config directory

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `shorthandConfigDirectory(environment?: NodeJS.ProcessEnv): string` — exported from
  `src/config.ts`. Task 8's `FileTokenProvider` stores its credentials file under this directory.

**Context:** The spec says the `google-login` credentials file belongs "alongside wherever
`DEFAULT_CONFIG` points... reuse that existing platform-path logic rather than inventing a second
convention." `src/config.ts` doesn't yet have a general "where does Shorthand keep its config"
function — only `detectShorthandExecutable`'s *executable search* paths. This task adds the missing
piece, following the exact same style (explicit `environment` parameter, no hidden `process.env`
reads, Windows/macOS/Linux branches matching `detectShorthandExecutable`'s existing conventions).

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.ts`:

```ts
import { homedir } from "node:os";
import { shorthandConfigDirectory } from "../src/config.js";

describe("shorthandConfigDirectory", () => {
  test("uses APPDATA on Windows", () => {
    if (process.platform !== "win32") return;
    expect(shorthandConfigDirectory({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }))
      .toBe(join("C:\\Users\\me\\AppData\\Roaming", "Shorthand"));
  });

  test("uses Library/Application Support on macOS", () => {
    if (process.platform !== "darwin") return;
    expect(shorthandConfigDirectory({ HOME: "/Users/me" }))
      .toBe(join("/Users/me", "Library", "Application Support", "Shorthand"));
  });

  test("uses XDG_CONFIG_HOME when set on Linux", () => {
    if (process.platform === "win32" || process.platform === "darwin") return;
    expect(shorthandConfigDirectory({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" }))
      .toBe(join("/xdg", "shorthand"));
  });

  test("falls back to ~/.config on Linux when XDG_CONFIG_HOME is unset", () => {
    if (process.platform === "win32" || process.platform === "darwin") return;
    expect(shorthandConfigDirectory({ HOME: "/home/me" }))
      .toBe(join("/home/me", ".config", "shorthand"));
  });

  test("falls back to os.homedir() when neither USERPROFILE nor HOME is set", () => {
    const detected = shorthandConfigDirectory({});
    expect(detected.startsWith(homedir()) || detected.includes(homedir())).toBe(true);
  });
});
```

Add `join` to the existing `node:path` import at the top of `test/config.test.ts` if not already
present.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — `shorthandConfigDirectory is not a function` (or a TS error from `typecheck`).

- [ ] **Step 3: Implement**

Add to `src/config.ts` (after `detectShorthandExecutable`):

```ts
/**
 * Where Shorthand's own config/credential files live, following the same
 * per-platform conventions detectShorthandExecutable already establishes for
 * finding the binary — so a second, inconsistent convention never gets invented.
 */
export function shorthandConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.USERPROFILE ?? environment.HOME ?? homedir();
  if (process.platform === "win32") {
    return join(environment.APPDATA ?? join(home, "AppData", "Roaming"), "Shorthand");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Shorthand");
  }
  return join(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "shorthand");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/config.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add shorthandConfigDirectory for Google credential storage"
```

---

### Task 2: The `TokenProvider` port

**Files:**
- Create: `src/auth/token-provider.ts`
- Modify: `src/index.ts`
- Test: `test/token-provider.test.ts`

**Interfaces:**
- Produces:
  - `interface TokenProvider { getAccessToken(): Promise<TokenResult> }`
  - `type TokenResult = { ok: true; token: string } | { ok: false; error: TokenError }`
  - `type TokenErrorCode = "not-authorized" | "revoked" | "transport"`
  - `type TokenError = Readonly<{ code: TokenErrorCode; message: string; cause?: unknown }>`
  - `function tokenError(code: TokenErrorCode, message: string, cause?: unknown): TokenError`
  - All exported from root `shorthand-core` (`src/index.ts`).
- Consumed by: Task 5's `GoogleApiDocsClient`, Task 8's `FileTokenProvider`.

**Context:** Spec: "The `TokenProvider` port (new)". This is a pure-types-plus-one-helper task —
same shape as `src/note/sink.ts`'s `sinkError`/`busySinkError`, which is the direct precedent for
`tokenError` (keeps `exactOptionalPropertyTypes` correct without every call site hand-rolling the
conditional `cause` spread).

- [ ] **Step 1: Write the failing test**

Create `test/token-provider.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { tokenError, type TokenProvider, type TokenResult } from "../src/auth/token-provider.js";

describe("tokenError", () => {
  test("omits cause entirely when not supplied", () => {
    const error = tokenError("not-authorized", "no credential yet");
    expect(error).toEqual({ code: "not-authorized", message: "no credential yet" });
    expect("cause" in error).toBe(false);
  });

  test("includes cause when supplied", () => {
    const cause = new Error("network down");
    const error = tokenError("transport", "refresh failed", cause);
    expect(error).toEqual({ code: "transport", message: "refresh failed", cause });
  });
});

describe("TokenProvider", () => {
  test("a conforming implementation satisfies the interface", async () => {
    const provider: TokenProvider = {
      getAccessToken: async (): Promise<TokenResult> => ({ ok: true, token: "abc" }),
    };
    expect(await provider.getAccessToken()).toEqual({ ok: true, token: "abc" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/token-provider.test.ts`
Expected: FAIL — module `../src/auth/token-provider.js` not found.

- [ ] **Step 3: Implement the port**

Create `src/auth/token-provider.ts`:

```ts
/**
 * The credential-supply port for API-backed sinks — the TokenProvider equivalent
 * of NoteSink (src/note/sink.ts). Core never performs OAuth or holds a browser
 * consent flow; a TokenProvider implementation is always a consumer concern.
 */

export type TokenErrorCode = "not-authorized" | "revoked" | "transport";

export type TokenError = Readonly<{
  code: TokenErrorCode;
  message: string;
  cause?: unknown;
}>;

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; error: TokenError };

export interface TokenProvider {
  getAccessToken(): Promise<TokenResult>;
}

export function tokenError(code: TokenErrorCode, message: string, cause?: unknown): TokenError {
  return { code, message, ...(cause === undefined ? {} : { cause }) };
}
```

- [ ] **Step 4: Export from the root entry point**

In `src/index.ts`, add (near the `sinkError`/`busySinkError` exports, since it's the same kind of
port):

```ts
export { tokenError } from "./auth/token-provider.js";
export type { TokenError, TokenErrorCode, TokenProvider, TokenResult } from "./auth/token-provider.js";
```

Update the "deliberately absent" comment block at the top of `src/index.ts` only if it currently
implies the file is exhaustive of all ports — check first; likely no change needed since that
comment is about internals, not new ports.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test test/token-provider.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth/token-provider.ts src/index.ts test/token-provider.test.ts
git commit -m "feat: add the TokenProvider port"
```

---

### Task 3: The markdown → Docs renderer

**Files:**
- Create: `src/google/renderer.ts`
- Test: `test/google-renderer.test.ts`
- Modify: `package.json`, `bun.lock` (via `bun add`)

**Interfaces:**
- Consumes: `Section` from `../note/markers.js` (`{ heading: string; markdown: string }`).
- Produces:
  - `type StyleSpanKind = { kind: "heading"; level: 1 | 2 | 3 } | { kind: "bullet" } | { kind: "bold" } | { kind: "link"; url: string }`
  - `type StyleSpan = Readonly<{ start: number; end: number; style: StyleSpanKind }>` — `start`/`end`
    are UTF-16 code-unit offsets into the returned `text`, `end` exclusive.
  - `type RenderedSections = Readonly<{ text: string; spans: readonly StyleSpan[] }>`
  - `function renderSections(sections: readonly Section[]): RenderedSections`
- Consumed by: Task 4's `buildWriteRequests`.

**Context:** Spec: "The markdown → Docs renderer" — "the largest net-new piece of work." The Docs
API has no markdown import path; every heading, bullet, bold run, and link needs an explicit style
request located by an offset range. **Use `marked` for the markdown parsing itself** (per this
plan's "prefer off-the-shelf" constraint) rather than hand-rolling paragraph/bullet/bold/link
detection with regex — that's a solved problem and inventing a second one here is exactly the kind
of unnecessary invention to avoid.

Supported markdown subset, matching exactly what the spec calls out (heading, bullet, bold, link):
paragraphs, `- `/`* ` bullet lists (one level; nested lists render as bullets at the same level —
Docs API nested-bullet indentation is out of scope for this pass), `**bold**` runs, and
`[text](url)` links, within each section's `markdown` body. Each section's own `heading` becomes a
Docs heading span (`level: 2`, matching the `##` the Markdown sink already uses for the same
`Section.heading` — see `## Summary` in `test/markdown-sink.test.ts`). Any other markdown construct
encountered inside a section body (nested heading, code block, blockquote, table, image) renders as
plain paragraph text with formatting stripped — defensive, not a crash, since nothing today
constrains what an LLM-produced `Section.markdown` may contain.

**Must be UTF-16-aware.** Build `text` as a plain JS string and compute all offsets against
`.length`/string slicing — JS strings are UTF-16 code units already, so no special handling is
needed as long as nothing iterates grapheme clusters or code points instead.

- [ ] **Step 1: Add dependencies**

```bash
bun add marked
```

Confirm `marked` appears in `package.json`'s `dependencies` and `bun.lock` is updated.

- [ ] **Step 2: Write the failing tests**

Create `test/google-renderer.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Section } from "../src/note/markers.js";
import { renderSections } from "../src/google/renderer.js";

describe("renderSections", () => {
  test("renders a section heading as a level-2 heading span", () => {
    const sections: readonly Section[] = [{ heading: "Summary", markdown: "Shipped." }];
    const { text, spans } = renderSections(sections);
    expect(text).toContain("Summary");
    expect(text).toContain("Shipped.");
    const heading = spans.find((span) => span.style.kind === "heading");
    expect(heading).toBeDefined();
    expect(text.slice(heading!.start, heading!.end)).toBe("Summary");
  });

  test("renders a bullet list with one bullet span per item", () => {
    const sections: readonly Section[] = [
      { heading: "Decisions", markdown: "- Ship Friday\n- Skip the retro\n" },
    ];
    const { text, spans } = renderSections(sections);
    const bullets = spans.filter((span) => span.style.kind === "bullet");
    expect(bullets).toHaveLength(2);
    expect(text.slice(bullets[0]!.start, bullets[0]!.end)).toContain("Ship Friday");
    expect(text.slice(bullets[1]!.start, bullets[1]!.end)).toContain("Skip the retro");
  });

  test("renders bold runs located within the plain text", () => {
    const sections: readonly Section[] = [{ heading: "Notes", markdown: "This is **important**." }];
    const { text, spans } = renderSections(sections);
    const bold = spans.find((span) => span.style.kind === "bold");
    expect(bold).toBeDefined();
    expect(text.slice(bold!.start, bold!.end)).toBe("important");
  });

  test("renders links with the URL captured on the span", () => {
    const sections: readonly Section[] = [
      { heading: "Notes", markdown: "See [the doc](https://example.com/x)." },
    ];
    const { text, spans } = renderSections(sections);
    const link = spans.find((span) => span.style.kind === "link");
    expect(link).toBeDefined();
    expect(link!.style.kind === "link" && link!.style.url).toBe("https://example.com/x");
    expect(text.slice(link!.start, link!.end)).toBe("the doc");
  });

  test("UTF-16 offsets stay correct across a multi-unit emoji", () => {
    const sections: readonly Section[] = [
      { heading: "Notes", markdown: "🎉 **great** work" },
    ];
    const { text, spans } = renderSections(sections);
    const bold = spans.find((span) => span.style.kind === "bold");
    expect(bold).toBeDefined();
    expect(text.slice(bold!.start, bold!.end)).toBe("great");
  });

  test("multiple sections concatenate in order, each with its own heading span", () => {
    const sections: readonly Section[] = [
      { heading: "Summary", markdown: "First." },
      { heading: "Decisions", markdown: "Second." },
    ];
    const { text, spans } = renderSections(sections);
    expect(text.indexOf("Summary")).toBeLessThan(text.indexOf("Decisions"));
    expect(spans.filter((span) => span.style.kind === "heading")).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/google-renderer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the renderer**

Create `src/google/renderer.ts`. Start from this implementation, then run the tests and adjust
field access to match the installed `marked` version's actual token shape — the compiler and the
tests are the source of truth for the exact token fields, not this snippet:

```ts
import { marked, type Token, type Tokens } from "marked";
import type { Section } from "../note/markers.js";

export type StyleSpanKind =
  | { kind: "heading"; level: 1 | 2 | 3 }
  | { kind: "bullet" }
  | { kind: "bold" }
  | { kind: "link"; url: string };

export type StyleSpan = Readonly<{
  start: number;
  end: number;
  style: StyleSpanKind;
}>;

export type RenderedSections = Readonly<{
  text: string;
  spans: readonly StyleSpan[];
}>;

export function renderSections(sections: readonly Section[]): RenderedSections {
  let text = "";
  const spans: StyleSpan[] = [];

  for (const section of sections) {
    const headingStart = text.length;
    text += section.heading;
    spans.push({ start: headingStart, end: text.length, style: { kind: "heading", level: 2 } });
    text += "\n";

    for (const token of marked.lexer(section.markdown)) {
      renderBlockToken(token, () => {
        text += "\n";
        return text.length;
      }, (chunk) => { text += chunk; return text.length; }, spans);
    }
  }

  return { text, spans };
}

function renderBlockToken(
  token: Token,
  newline: () => number,
  append: (chunk: string) => number,
  spans: StyleSpan[],
): void {
  if (token.type === "paragraph") {
    renderInline((token as Tokens.Paragraph).tokens ?? [], append, spans);
    newline();
    return;
  }
  if (token.type === "list") {
    for (const item of (token as Tokens.List).items) {
      const bulletStart = append("");
      renderInline(item.tokens.flatMap(extractInline), append, spans);
      spans.push({ start: bulletStart, end: append(""), style: { kind: "bullet" } });
      newline();
    }
    return;
  }
  // Anything else (heading inside a section body, code, blockquote, table, image):
  // fall back to plain text so an unexpected LLM-produced construct never throws.
  append(token.raw.replace(/[*_`>#|]/g, "").trim());
  newline();
}

function extractInline(token: Token): Token[] {
  if (token.type === "text" && "tokens" in token && token.tokens) return token.tokens;
  return [token];
}

function renderInline(tokens: readonly Token[], append: (chunk: string) => number, spans: StyleSpan[]): void {
  for (const token of tokens) {
    if (token.type === "strong") {
      const start = append("");
      renderInline((token as Tokens.Strong).tokens, append, spans);
      spans.push({ start, end: append(""), style: { kind: "bold" } });
    } else if (token.type === "link") {
      const linkToken = token as Tokens.Link;
      const start = append("");
      renderInline(linkToken.tokens, append, spans);
      spans.push({ start, end: append(""), style: { kind: "link", url: linkToken.href } });
    } else if (token.type === "text" || token.type === "codespan" || token.type === "em") {
      append((token as Tokens.Text).text ?? token.raw);
    }
  }
}
```

Note the `append("")` / re-reading `append("")` pattern above is a placeholder for "get the
current text length without appending" — replace with a cleaner `currentLength()` closure over
`text.length` if that reads better; the point is spans must be computed from the *actual* final
offsets after all nested inline content has been appended, not estimated in advance.

- [ ] **Step 5: Run tests and iterate**

Run: `bun test test/google-renderer.test.ts`

Fix field-name mismatches against the installed `marked` types (`Tokens.Paragraph`, `Tokens.List`,
`Tokens.Strong`, `Tokens.Link`, `Tokens.Text` — inspect `node_modules/marked/lib/marked.d.ts` if a
field doesn't exist) until all six tests pass.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/google/renderer.ts test/google-renderer.test.ts
git commit -m "feat: render Section[] to plain text plus Docs style spans"
```

---

### Task 4: The `batchUpdate` request builder

**Files:**
- Create: `src/google/requests.ts`
- Test: `test/google-requests.test.ts`
- Modify: `package.json`, `bun.lock` (via `bun add`)

**Interfaces:**
- Consumes: `StyleSpan`, `RenderedSections` from `./renderer.js` (Task 3); `docs_v1.Schema$Request`
  type from `googleapis`.
- Produces: `function buildWriteRequests(options: BuildWriteRequestsOptions): docs_v1.Schema$Request[]`
  where
  ```ts
  type BuildWriteRequestsOptions = Readonly<{
    tabId: string;
    bodyEndIndex: number;
    text: string;
    spans: readonly StyleSpan[];
  }>;
  ```
- Consumed by: Task 6's `GoogleDocsNoteSink.write()`.

**Context:** Spec: "write()" — the exact request shape and ordering. **Request array order is
literally `[deleteContentRange?, insertText?, ...styleRequests]`** — delete old content, then
insert the freshly rendered text, then apply style requests that reference offsets *within that
just-inserted text*. This is not a blind numeric sort of the whole array by `startIndex`: style
requests must execute after `insertText` creates the text they target, or their ranges don't exist
yet. `deleteContentRange`/`insertText` themselves are the only requests that shift indices; the
three style request types (`updateParagraphStyle`, `createParagraphBullets`, `updateTextStyle`)
change formatting only and never shift indices, so their order relative to *each other* doesn't
matter. Confirming this ordering against a real document is one of the mandatory live-prototype
checks in Task 11 — this task's tests only prove the array shape is what the spec describes.

`deleteContentRange` is emitted only when there's existing content to delete (`bodyEndIndex - 1 >
1`); `insertText` is emitted only when `text.length > 0`. The API forbids deleting a Body's final
newline character, hence `endIndex: bodyEndIndex - 1`, never `bodyEndIndex`.

Every request must carry an explicit `tabId` — assert this before returning, don't trust every
branch below to have set it correctly.

- [ ] **Step 1: Add dependencies**

```bash
bun add googleapis
```

`googleapis` is used here only for its `docs_v1.Schema$Request` **type** (no runtime import) — the
runtime client lives in Task 5.

- [ ] **Step 2: Write the failing tests**

Create `test/google-requests.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildWriteRequests } from "../src/google/requests.js";
import type { StyleSpan } from "../src/google/renderer.js";

describe("buildWriteRequests", () => {
  test("emits delete, then insert, then style requests, in that order", () => {
    const spans: readonly StyleSpan[] = [
      { start: 0, end: 7, style: { kind: "heading", level: 2 } },
    ];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 50, text: "Summary\n", spans });
    expect(Object.keys(requests[0]!)).toEqual(["deleteContentRange"]);
    expect(Object.keys(requests[1]!)).toEqual(["insertText"]);
    expect(Object.keys(requests[2]!)).toEqual(["updateParagraphStyle"]);
  });

  test("deleteContentRange uses bodyEndIndex - 1, never bodyEndIndex", () => {
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 50, text: "x", spans: [] });
    expect(requests[0]!.deleteContentRange).toMatchObject({
      range: { tabId: "t1", startIndex: 1, endIndex: 49 },
    });
  });

  test("omits deleteContentRange when the tab body is already empty", () => {
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "x", spans: [] });
    expect(requests.some((request) => "deleteContentRange" in request)).toBe(false);
  });

  test("omits insertText when the rendered text is empty", () => {
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 5, text: "", spans: [] });
    expect(requests.some((request) => "insertText" in request)).toBe(false);
  });

  test("insertText targets index 1 with the full text, tabId included", () => {
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 5, text: "hello", spans: [] });
    expect(requests.find((request) => "insertText" in request)!.insertText).toEqual({
      location: { tabId: "t1", index: 1 },
      text: "hello",
    });
  });

  test("a bullet span becomes createParagraphBullets over the shifted range", () => {
    const spans: readonly StyleSpan[] = [{ start: 0, end: 4, style: { kind: "bullet" } }];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "Ship", spans });
    const bullet = requests.find((request) => "createParagraphBullets" in request)!.createParagraphBullets;
    expect(bullet).toMatchObject({ range: { tabId: "t1", startIndex: 1, endIndex: 5 } });
  });

  test("a bold span becomes updateTextStyle with fields=bold over the shifted range", () => {
    const spans: readonly StyleSpan[] = [{ start: 2, end: 6, style: { kind: "bold" } }];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "ok bold ok", spans });
    const style = requests.find((request) => "updateTextStyle" in request)!.updateTextStyle;
    expect(style).toMatchObject({
      range: { tabId: "t1", startIndex: 3, endIndex: 7 },
      textStyle: { bold: true },
      fields: "bold",
    });
  });

  test("a link span becomes updateTextStyle with fields=link and the URL", () => {
    const spans: readonly StyleSpan[] = [{ start: 0, end: 3, style: { kind: "link", url: "https://x" } }];
    const requests = buildWriteRequests({ tabId: "t1", bodyEndIndex: 1, text: "doc", spans });
    const style = requests.find((request) => "updateTextStyle" in request)!.updateTextStyle;
    expect(style).toMatchObject({
      textStyle: { link: { url: "https://x" } },
      fields: "link",
    });
  });

  test("throws if any constructed request would lack a tabId", () => {
    expect(() => buildWriteRequests({ tabId: "", bodyEndIndex: 5, text: "x", spans: [] })).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/google-requests.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/google/requests.ts`:

```ts
import type { docs_v1 } from "googleapis";
import type { StyleSpan } from "./renderer.js";

export type BuildWriteRequestsOptions = Readonly<{
  tabId: string;
  bodyEndIndex: number;
  text: string;
  spans: readonly StyleSpan[];
}>;

const NAMED_STYLE_BY_LEVEL: Record<1 | 2 | 3, string> = {
  1: "HEADING_1",
  2: "HEADING_2",
  3: "HEADING_3",
};

/**
 * Delete-then-insert-then-style, in that literal order: style requests target
 * offsets within the text insertText is about to create, so they cannot run
 * before it. Google's "write backwards" guidance governs ordering among
 * index-shifting requests (delete/insert); the three style request types below
 * never shift indices, so their order relative to each other is irrelevant.
 */
export function buildWriteRequests(options: BuildWriteRequestsOptions): docs_v1.Schema$Request[] {
  const { tabId, bodyEndIndex, text, spans } = options;
  const requests: docs_v1.Schema$Request[] = [];

  if (bodyEndIndex - 1 > 1) {
    requests.push({
      deleteContentRange: { range: { tabId, startIndex: 1, endIndex: bodyEndIndex - 1 } },
    });
  }
  if (text.length > 0) {
    requests.push({ insertText: { location: { tabId, index: 1 }, text } });
  }
  for (const span of spans) {
    requests.push(styleRequest(tabId, span));
  }

  for (const request of requests) assertHasTabId(request);
  return requests;
}

function styleRequest(tabId: string, span: StyleSpan): docs_v1.Schema$Request {
  const range = { tabId, startIndex: span.start + 1, endIndex: span.end + 1 };
  if (span.style.kind === "heading") {
    return {
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: NAMED_STYLE_BY_LEVEL[span.style.level] },
        fields: "namedStyleType",
      },
    };
  }
  if (span.style.kind === "bullet") {
    return {
      createParagraphBullets: { range, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
    };
  }
  if (span.style.kind === "bold") {
    return { updateTextStyle: { range, textStyle: { bold: true }, fields: "bold" } };
  }
  return {
    updateTextStyle: { range, textStyle: { link: { url: span.style.url } }, fields: "link" },
  };
}

function assertHasTabId(request: docs_v1.Schema$Request): void {
  const range = request.deleteContentRange?.range
    ?? request.updateParagraphStyle?.range
    ?? request.createParagraphBullets?.range
    ?? request.updateTextStyle?.range;
  const location = request.insertText?.location;
  const tabId = range?.tabId ?? location?.tabId;
  if (tabId === undefined || tabId === null || tabId.length === 0) {
    throw new Error(`Docs request built without a tabId: ${JSON.stringify(request)}`);
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test test/google-requests.test.ts && bun run typecheck`
Expected: PASS. If `googleapis`'s `Schema$Request` field names differ slightly (e.g. bullet preset
enum values), fix against the installed package's types — check
`node_modules/googleapis/build/src/apis/docs/v1.d.ts`.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/google/requests.ts test/google-requests.test.ts
git commit -m "feat: build ordered Docs batchUpdate requests from rendered spans"
```

---

### Task 5: `GoogleDocsApi` adapter over `googleapis`

**Files:**
- Create: `src/google/docs-client.ts`
- Test: `test/google-docs-client.test.ts`
- Modify: `package.json`, `bun.lock` (via `bun add`)

**Interfaces:**
- Consumes: `TokenProvider` (Task 2).
- Produces:
  ```ts
  export type DocsApiError = Readonly<{ httpStatus: number; retryAfterMs?: number; message: string }>;
  export type DocsApiResult<T> = { ok: true; value: T } | { ok: false; error: DocsApiError };

  export type DocsParagraph = Readonly<{ text: string; headingLevel?: 1 | 2 | 3; bullet: boolean }>;
  export type DocsTab = Readonly<{
    tabId: string;
    bodyEndIndex: number;
    paragraphs: readonly DocsParagraph[];
    childTabs: readonly DocsTab[];
  }>;
  export type GetDocumentValue = Readonly<{ revisionId: string; tabs: readonly DocsTab[] }>;
  export type BatchUpdateValue = Readonly<{ revisionId: string }>;

  export interface GoogleDocsApi {
    getDocument(documentId: string): Promise<DocsApiResult<GetDocumentValue>>;
    batchUpdate(
      documentId: string,
      requests: readonly docs_v1.Schema$Request[],
      targetRevisionId?: string,
    ): Promise<DocsApiResult<BatchUpdateValue>>;
  }

  export class GoogleApiDocsClient implements GoogleDocsApi { constructor(tokenProvider: TokenProvider); ... }
  ```
- Consumed by: Task 6's `GoogleDocsNoteSink` (via the `GoogleDocsApi` interface — tests for Task 6
  and 7 inject a fake `GoogleDocsApi`, never `GoogleApiDocsClient` itself).

**Context:** Spec: "read()", "write()", "Concurrency", "Error mapping". This is a thin adapter: its
only job is (1) turn a `TokenProvider` into Google auth credentials `googleapis` can use, (2) call
`documents.get`/`documents.batchUpdate`, (3) normalize the tab tree and any thrown HTTP error into
the shapes above. **Do not re-test `googleapis`'s own HTTP behavior** — inject a fake
`docs_v1.Docs`-shaped object in tests and assert only this adapter's own translation logic (error
status → `DocsApiError`, `Retry-After` seconds → `retryAfterMs` milliseconds, tab-tree flattening).

- [ ] **Step 1: Add dependencies**

```bash
bun add google-auth-library
```

(`googleapis` was already added in Task 4.)

- [ ] **Step 2: Write the failing tests**

Create `test/google-docs-client.test.ts`. Inject a fake shaped like the slice of `docs_v1.Docs`
this adapter actually calls (`documents.get`, `documents.batchUpdate`) via a constructor seam —
add an optional second constructor parameter to `GoogleApiDocsClient` for exactly this purpose (see
Step 3):

```ts
import { describe, expect, test } from "bun:test";
import { GoogleApiDocsClient } from "../src/google/docs-client.js";
import type { TokenProvider } from "../src/auth/token-provider.js";

const okTokenProvider: TokenProvider = { getAccessToken: async () => ({ ok: true, token: "t" }) };

function gaxiosError(status: number, headers: Record<string, string> = {}): Error & { response: unknown } {
  const error = new Error(`request failed with status code ${status}`) as Error & { response: unknown };
  error.response = { status, headers };
  return error;
}

describe("GoogleApiDocsClient", () => {
  test("maps a 429 with Retry-After seconds to retryAfterMs milliseconds", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw gaxiosError(429, { "retry-after": "2" }); },
        batchUpdate: async () => { throw gaxiosError(429, { "retry-after": "2" }); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    expect(result).toEqual({ ok: false, error: { httpStatus: 429, retryAfterMs: 2000, message: expect.any(String) } });
  });

  test("maps a 401 and a 403 to the same httpStatus shape", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: { get: async () => { throw gaxiosError(403); }, batchUpdate: async () => { throw gaxiosError(403); } },
    } as never);
    expect((await client.getDocument("doc1")).ok).toBe(false);
    const result = await client.getDocument("doc1");
    if (!result.ok) expect(result.error.httpStatus).toBe(403);
  });

  test("maps a 404 to httpStatus 404", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: { get: async () => { throw gaxiosError(404); }, batchUpdate: async () => { throw gaxiosError(404); } },
    } as never);
    const result = await client.getDocument("doc1");
    if (!result.ok) expect(result.error.httpStatus).toBe(404);
  });

  test("flattens the tab tree and reports each tab's body end index", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => ({
          data: {
            revisionId: "rev1",
            tabs: [
              {
                tabProperties: { tabId: "root" },
                documentTab: { body: { content: [{ endIndex: 3 }, { endIndex: 12 }] } },
                childTabs: [
                  {
                    tabProperties: { tabId: "child" },
                    documentTab: { body: { content: [{ endIndex: 5 }] } },
                    childTabs: [],
                  },
                ],
              },
            ],
          },
        }),
        batchUpdate: async () => { throw new Error("not used in this test"); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    expect(result).toEqual({
      ok: true,
      value: {
        revisionId: "rev1",
        tabs: [
          {
            tabId: "root",
            bodyEndIndex: 12,
            paragraphs: [],
            childTabs: [{ tabId: "child", bodyEndIndex: 5, paragraphs: [], childTabs: [] }],
          },
        ],
      },
    });
  });

  test("extracts paragraph text, heading level, and bullet flag from body content", async () => {
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => ({
          data: {
            revisionId: "rev1",
            tabs: [
              {
                tabProperties: { tabId: "owned" },
                documentTab: {
                  body: {
                    content: [
                      {
                        endIndex: 9,
                        paragraph: {
                          paragraphStyle: { namedStyleType: "HEADING_2" },
                          elements: [{ textRun: { content: "Summary\n" } }],
                        },
                      },
                      {
                        endIndex: 18,
                        paragraph: {
                          bullet: { listId: "list1" },
                          elements: [{ textRun: { content: "Ship Friday\n" } }],
                        },
                      },
                    ],
                  },
                },
                childTabs: [],
              },
            ],
          },
        }),
        batchUpdate: async () => { throw new Error("not used in this test"); },
      },
    } as never);
    const result = await client.getDocument("doc1");
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tabs[0]!.paragraphs).toEqual([
      { text: "Summary", headingLevel: 2, bullet: false },
      { text: "Ship Friday", headingLevel: undefined, bullet: true },
    ]);
  });

  test("batchUpdate passes targetRevisionId through writeControl and returns the new revisionId", async () => {
    let capturedWriteControl: unknown;
    const client = new GoogleApiDocsClient(okTokenProvider, {
      documents: {
        get: async () => { throw new Error("not used in this test"); },
        batchUpdate: async (params: { requestBody: { writeControl?: unknown } }) => {
          capturedWriteControl = params.requestBody.writeControl;
          return { data: { writeControl: { requiredRevisionId: "rev2" } } };
        },
      },
    } as never);
    const result = await client.batchUpdate("doc1", [], "rev1");
    expect(capturedWriteControl).toEqual({ targetRevisionId: "rev1" });
    expect(result).toEqual({ ok: true, value: { revisionId: "rev2" } });
  });
});
```

Adjust the `batchUpdate` response shape assertion once you've checked what field the real
`docs_v1.Schema$BatchUpdateDocumentResponse` actually returns the new revision id under (check
`node_modules/googleapis/build/src/apis/docs/v1.d.ts` — it may be under `writeControl` echoed back,
or the response may not carry a fresh revision id at all, in which case a follow-up `documents.get`
convention may be needed; resolve this against the real types, not by guessing further here, and
adjust `BatchUpdateValue`/the test above to match).

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/google-docs-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/google/docs-client.ts`:

```ts
import { docs_v1, google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import type { TokenProvider } from "../auth/token-provider.js";

export type DocsApiError = Readonly<{ httpStatus: number; retryAfterMs?: number; message: string }>;
export type DocsApiResult<T> = { ok: true; value: T } | { ok: false; error: DocsApiError };

export type DocsParagraph = Readonly<{ text: string; headingLevel?: 1 | 2 | 3; bullet: boolean }>;
export type DocsTab = Readonly<{
  tabId: string;
  bodyEndIndex: number;
  paragraphs: readonly DocsParagraph[];
  childTabs: readonly DocsTab[];
}>;
export type GetDocumentValue = Readonly<{ revisionId: string; tabs: readonly DocsTab[] }>;
export type BatchUpdateValue = Readonly<{ revisionId: string }>;

export interface GoogleDocsApi {
  getDocument(documentId: string): Promise<DocsApiResult<GetDocumentValue>>;
  batchUpdate(
    documentId: string,
    requests: readonly docs_v1.Schema$Request[],
    targetRevisionId?: string,
  ): Promise<DocsApiResult<BatchUpdateValue>>;
}

type DocsResource = Pick<docs_v1.Docs, "documents">;

export class GoogleApiDocsClient implements GoogleDocsApi {
  readonly #documents: DocsResource["documents"];

  constructor(tokenProvider: TokenProvider, documents?: DocsResource["documents"]) {
    if (documents !== undefined) {
      this.#documents = documents;
      return;
    }
    const auth = new OAuth2Client();
    auth.setCredentials({});
    // getRequestHeaders is overridden so every call asks the TokenProvider fresh,
    // rather than caching a token this client has no way to invalidate on `revoked`.
    auth.getRequestHeaders = async () => {
      const result = await tokenProvider.getAccessToken();
      if (!result.ok) throw new Error(`TokenProvider: ${result.error.code}: ${result.error.message}`);
      return { Authorization: `Bearer ${result.token}` };
    };
    this.#documents = google.docs({ version: "v1", auth }).documents;
  }

  async getDocument(documentId: string): Promise<DocsApiResult<GetDocumentValue>> {
    try {
      const response = await this.#documents.get({ documentId, includeTabsContent: true });
      const tabs = (response.data.tabs ?? []).map(toDocsTab);
      return { ok: true, value: { revisionId: response.data.revisionId ?? "", tabs } };
    } catch (error) {
      return { ok: false, error: toDocsApiError(error) };
    }
  }

  async batchUpdate(
    documentId: string,
    requests: readonly docs_v1.Schema$Request[],
    targetRevisionId?: string,
  ): Promise<DocsApiResult<BatchUpdateValue>> {
    try {
      const response = await this.#documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [...requests],
          ...(targetRevisionId === undefined ? {} : { writeControl: { targetRevisionId } }),
        },
      });
      const revisionId = response.data.writeControl?.requiredRevisionId ?? "";
      return { ok: true, value: { revisionId } };
    } catch (error) {
      return { ok: false, error: toDocsApiError(error) };
    }
  }
}

const HEADING_LEVEL_BY_NAMED_STYLE: Record<string, 1 | 2 | 3> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
};

function toDocsTab(tab: docs_v1.Schema$Tab): DocsTab {
  const content = tab.documentTab?.body?.content ?? [];
  const bodyEndIndex = content.reduce((max, element) => Math.max(max, element.endIndex ?? 0), 0);
  const paragraphs = content
    .map((element) => element.paragraph)
    .filter((paragraph): paragraph is docs_v1.Schema$Paragraph => paragraph !== undefined)
    .map(toDocsParagraph)
    .filter((paragraph) => paragraph.text.length > 0);
  return {
    tabId: tab.tabProperties?.tabId ?? "",
    bodyEndIndex,
    paragraphs,
    childTabs: (tab.childTabs ?? []).map(toDocsTab),
  };
}

function toDocsParagraph(paragraph: docs_v1.Schema$Paragraph): DocsParagraph {
  const text = (paragraph.elements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");
  const namedStyle = paragraph.paragraphStyle?.namedStyleType;
  const headingLevel = namedStyle !== undefined ? HEADING_LEVEL_BY_NAMED_STYLE[namedStyle] : undefined;
  return {
    text,
    ...(headingLevel === undefined ? {} : { headingLevel }),
    bullet: paragraph.bullet !== undefined,
  };
}

function toDocsApiError(error: unknown): DocsApiError {
  const response = (error as { response?: { status?: number; headers?: Record<string, string> } }).response;
  const status = response?.status ?? 0;
  const retryAfterHeader = response?.headers?.["retry-after"];
  const retryAfterMs = retryAfterHeader !== undefined ? Number(retryAfterHeader) * 1000 : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return { httpStatus: status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), message };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test test/google-docs-client.test.ts && bun run typecheck`
Expected: PASS. Resolve any type mismatch against `googleapis`'s real `docs_v1` types rather than
casting broadly — the `as never` casts in the test file are for the *fake* documents object only,
not for production code.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/google/docs-client.ts test/google-docs-client.test.ts
git commit -m "feat: add a thin GoogleDocsApi adapter over the googleapis Docs client"
```

---

### Task 6: `GoogleDocsNoteSink`

**Files:**
- Create: `src/google/docs-sink.ts`
- Test: `test/google-docs-sink-unit.test.ts` (unit-level; Task 7 adds the conformance suite)

**Interfaces:**
- Consumes: `GoogleDocsApi` (Task 5), `renderSections` (Task 3), `buildWriteRequests` (Task 4),
  `NoteSink`/`SinkError`/`SinkReadResult`/`SinkWriteResult`/`sinkError`/`busySinkError` from
  `../note/sink.js`.
- Produces:
  ```ts
  export const GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/drive.file";

  export type GoogleDocsNoteSinkOptions = Readonly<{
    documentId: string;
    tabId: string;
    api: GoogleDocsApi;
    describe?: string;
  }>;
  export class GoogleDocsNoteSink implements NoteSink { constructor(options: GoogleDocsNoteSinkOptions); read(); write(); readonly describe: string; }
  ```
- Consumed by: Task 7's conformance suite, Task 9's `shorthand-core/google` entry point.

**Context:** Spec: "read()", "write()", "Concurrency", "Error mapping", "Meeting start". No
`agentContext` is ever set (spec's "Explicitly out of scope" + `CONTRACT.md` §2.4 — an API sink has
no vault). `read()` locates the owned tab by walking the tab tree (including `childTabs`) for a
matching `tabId`, never by position. `write()` calls `renderSections` → `buildWriteRequests` →
`api.batchUpdate` with `targetRevisionId: expectedRevision`, mapping the result per
`docs/CONTRACT.md` §4 (this task owns the actual `SinkWriteResult`/`SinkReadResult` mapping;
Task 5's `DocsApiError.httpStatus` is the input to that mapping).

**Ruling (made during plan review, before Task 6 was dispatched): `write()` must implement
`unchanged`.** The original draft of this task called `batchUpdate` unconditionally on every write,
which never produces `docs/CONTRACT.md` §2.2's `unchanged` outcome — a real gap, not a style
choice: `src/testing/sink-conformance.ts` has a mandatory scenario ("reports unchanged... when the
sections already match") that this would have failed. Fixed by comparing
`renderSections(sections).text` against `renderSections(parseTabToSections(tab)).text` — both sides
pass through the same renderer, so the lossy Docs round-trip (see the next ruling) cancels out
rather than causing a false "changed". **Stale outranks equality** (same §2.2): the comparison only
runs when `read.value.revisionId === expectedRevision`; when it doesn't, execution falls through to
the normal `batchUpdate` call, whose `targetRevisionId` rejection maps to `{ status: "stale" }` —
never short-circuited to `unchanged` on a stale revision, even when content happens to match.

**Ruling (made during plan review, before Task 6 was dispatched):** `read()` must return the tab's
*actual* current sections, not `sections: []`. `src/agent/runner.ts:212-220,238` feeds
`read().value.sections` into the agent's revision prompt (`buildPassPrompt`) and uses
`observed.sections.length > 0` to skip a redundant `link`-tier pass when nothing changed
(`requestedTier === "link" && input.transcript.length === 0 && observed.sections.length > 0`) —
both would silently misbehave against an always-empty `sections`. Reconstruct `Section[]` from
`DocsTab.paragraphs` (Task 5): a paragraph with `headingLevel` starts a new section (its `text`
becomes `Section.heading`); subsequent non-heading paragraphs join into that section's `markdown`
(bullet paragraphs prefixed with `"- "`, others joined by blank lines). This is a deliberately
**lossy** round-trip — bold/link *markdown syntax* is not reconstructed from Docs text-run styling,
only the plain text is — because `EnhanceRunner` needs prior sections for prompt context and the
`length > 0` check, not a byte-perfect markdown string back. Full inverse-styling reconstruction is
more machinery than phases 1a/1b need; revisit if a later phase needs exact round-tripping.
`userNotes` stays `""` — the whole tab is AI-owned per the spec's "Why tabs simplify this sink",
there is nothing else in it to read as user prose.

Note: `addDocumentTab` ("Meeting start") is deliberately **not** part of `GoogleDocsNoteSink` — the
spec calls it out as "the one call in the whole sink that happens outside the read/write pass
loop," i.e. a one-time setup step a *consumer* performs once per meeting to obtain the `tabId`
this sink is then constructed with. Task 9 implements it as a standalone exported function next to
the CLI wiring, since nothing in phases 1a/1b's automated tests exercises it against a live
document (that's Task 11's manual gate).

- [ ] **Step 1: Write the failing tests**

Create `test/google-docs-sink-unit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { GoogleDocsNoteSink } from "../src/google/docs-sink.js";
import type { GoogleDocsApi, GetDocumentValue, BatchUpdateValue, DocsApiResult } from "../src/google/docs-client.js";

function fakeApi(overrides: Partial<GoogleDocsApi> = {}): GoogleDocsApi {
  return {
    getDocument: async (): Promise<DocsApiResult<GetDocumentValue>> => ({
      ok: true,
      value: { revisionId: "rev1", tabs: [{ tabId: "owned", bodyEndIndex: 1, paragraphs: [], childTabs: [] }] },
    }),
    batchUpdate: async (): Promise<DocsApiResult<BatchUpdateValue>> => ({ ok: true, value: { revisionId: "rev2" } }),
    ...overrides,
  };
}

describe("GoogleDocsNoteSink.read", () => {
  test("locates the owned tab by tabId, not position", async () => {
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev1",
          tabs: [
            { tabId: "someone-elses-notes", bodyEndIndex: 40, paragraphs: [], childTabs: [] },
            { tabId: "owned", bodyEndIndex: 1, paragraphs: [], childTabs: [] },
          ],
        },
      }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.read();
    expect(result.ok).toBe(true);
  });

  test("finds a tab nested under childTabs", async () => {
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev1",
          tabs: [{ tabId: "root", bodyEndIndex: 1, paragraphs: [], childTabs: [{ tabId: "owned", bodyEndIndex: 1, paragraphs: [], childTabs: [] }] }],
        },
      }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    expect((await sink.read()).ok).toBe(true);
  });

  test("reconstructs sections from the tab's paragraphs", async () => {
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev1",
          tabs: [{
            tabId: "owned",
            bodyEndIndex: 1,
            childTabs: [],
            paragraphs: [
              { text: "Summary", headingLevel: 2, bullet: false },
              { text: "Shipped Friday.", bullet: false },
              { text: "Decisions", headingLevel: 2, bullet: false },
              { text: "Ship it", bullet: true },
              { text: "Skip the retro", bullet: true },
            ],
          }],
        },
      }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.read();
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.sections).toEqual([
      { heading: "Summary", markdown: "Shipped Friday." },
      { heading: "Decisions", markdown: "- Ship it\n- Skip the retro" },
    ]);
    expect(result.value.userNotes).toBe("");
  });

  test("a missing owned tab reads as invalid-target", async () => {
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "missing", api: fakeApi() });
    expect(await sink.read()).toMatchObject({ ok: false, error: { code: "invalid-target" } });
  });

  test.each([
    [401, "forbidden"], [403, "forbidden"], [404, "not-found"], [429, "busy"], [500, "transport"],
  ])("httpStatus %d maps to read error code %s", async (httpStatus, code) => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ getDocument: async () => ({ ok: false, error: { httpStatus, message: "x" } }) }),
    });
    expect(await sink.read()).toMatchObject({ ok: false, error: { code } });
  });
});

describe("GoogleDocsNoteSink.write", () => {
  test("a successful write returns the new revisionId", async () => {
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api: fakeApi() });
    const result = await sink.write([{ heading: "Summary", markdown: "Shipped." }], "rev1");
    expect(result).toEqual({ status: "written", revision: "rev2" });
  });

  test("returns unchanged, without calling batchUpdate, when the rendered text already matches", async () => {
    let batchUpdateCalled = false;
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev1",
          tabs: [{
            tabId: "owned", bodyEndIndex: 1, childTabs: [],
            paragraphs: [
              { text: "Summary", headingLevel: 2, bullet: false },
              { text: "Shipped.", bullet: false },
            ],
          }],
        },
      }),
      batchUpdate: async () => { batchUpdateCalled = true; return { ok: true, value: { revisionId: "rev2" } }; },
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.write([{ heading: "Summary", markdown: "Shipped." }], "rev1");
    expect(result).toEqual({ status: "unchanged", revision: "rev1" });
    expect(batchUpdateCalled).toBe(false);
  });

  test("staleness outranks equality: identical content at a stale revision is still stale, not unchanged", async () => {
    const api = fakeApi({
      getDocument: async () => ({
        ok: true,
        value: {
          revisionId: "rev2",
          tabs: [{
            tabId: "owned", bodyEndIndex: 1, childTabs: [],
            paragraphs: [
              { text: "Summary", headingLevel: 2, bullet: false },
              { text: "Shipped.", bullet: false },
            ],
          }],
        },
      }),
      batchUpdate: async () => ({ ok: false, error: { httpStatus: 409, message: "stale" } }),
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    const result = await sink.write([{ heading: "Summary", markdown: "Shipped." }], "rev1");
    expect(result).toEqual({ status: "stale" });
  });

  test("targetRevisionId is passed through as expectedRevision", async () => {
    let capturedRevision: string | undefined;
    const api = fakeApi({
      batchUpdate: async (_documentId, _requests, targetRevisionId) => {
        capturedRevision = targetRevisionId;
        return { ok: true, value: { revisionId: "rev2" } };
      },
    });
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api });
    await sink.write([{ heading: "Summary", markdown: "x" }], "rev1");
    expect(capturedRevision).toBe("rev1");
  });

  test.each([
    [409, "stale"], [412, "stale"],
  ])("httpStatus %d maps to write status %s", async (httpStatus, status) => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus, message: "x" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toEqual({ status });
  });

  test("httpStatus 429 maps to busy with retryAfterMs carried through", async () => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus: 429, retryAfterMs: 3000, message: "x" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toEqual({ status: "busy", retryAfterMs: 3000 });
  });

  test("httpStatus 401/403 maps to a forbidden error status", async () => {
    const sink = new GoogleDocsNoteSink({
      documentId: "d1", tabId: "owned",
      api: fakeApi({ batchUpdate: async () => ({ ok: false, error: { httpStatus: 403, message: "x" } }) }),
    });
    expect(await sink.write([{ heading: "Summary", markdown: "x" }], "rev1")).toMatchObject({ status: "error", error: { code: "forbidden" } });
  });

  test("agentContext is never set", () => {
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api: fakeApi() });
    expect(sink.agentContext).toBeUndefined();
  });

  test("describe defaults to the document id when not supplied", () => {
    const sink = new GoogleDocsNoteSink({ documentId: "d1", tabId: "owned", api: fakeApi() });
    expect(sink.describe).toContain("d1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/google-docs-sink-unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/google/docs-sink.ts`:

```ts
import { renderSections } from "./renderer.js";
import { buildWriteRequests } from "./requests.js";
import type { DocsApiError, DocsTab, GoogleDocsApi } from "./docs-client.js";
import type { Section } from "../note/markers.js";
import { busySinkError, sinkError, type NoteSink, type SinkError, type SinkReadResult, type SinkWriteResult } from "../note/sink.js";

export const GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type GoogleDocsNoteSinkOptions = Readonly<{
  documentId: string;
  tabId: string;
  api: GoogleDocsApi;
  describe?: string;
}>;

export class GoogleDocsNoteSink implements NoteSink {
  // Declared but never assigned: an API sink has no vault to offer, so this
  // always reads as undefined — but the field must exist on the class for
  // `sink.agentContext` (used in tests) to typecheck against the concrete
  // class rather than only the NoteSink interface.
  readonly agentContext?: { cwd: string };
  readonly describe: string;
  readonly #documentId: string;
  readonly #tabId: string;
  readonly #api: GoogleDocsApi;

  constructor(options: GoogleDocsNoteSinkOptions) {
    this.#documentId = options.documentId;
    this.#tabId = options.tabId;
    this.#api = options.api;
    this.describe = options.describe ?? `Google Doc ${options.documentId} (tab ${options.tabId})`;
  }

  async read(): Promise<SinkReadResult> {
    const result = await this.#api.getDocument(this.#documentId);
    if (!result.ok) return { ok: false, error: readErrorFor(result.error) };
    const tab = findTab(result.value.tabs, this.#tabId);
    if (tab === undefined) {
      return { ok: false, error: sinkError("invalid-target", `Tab ${this.#tabId} not found in document ${this.#documentId}`) };
    }
    return { ok: true, value: { sections: parseTabToSections(tab), userNotes: "", revision: result.value.revisionId } };
  }

  async write(sections: readonly Section[], expectedRevision: string): Promise<SinkWriteResult> {
    // A blank heading can't be represented as a Docs paragraph that
    // parseTabToSections could ever recover a section boundary from (its
    // heading-detection is `headingLevel !== undefined`, not text content),
    // so refuse it here rather than silently rendering an empty title.
    const blankHeading = sections.find((section) => section.heading.trim().length === 0);
    if (blankHeading !== undefined) {
      return { status: "error", error: sinkError("invalid-content", "Section heading must not be empty") };
    }
    const read = await this.#api.getDocument(this.#documentId);
    if (!read.ok) return writeErrorFor(read.error);
    const tab = findTab(read.value.tabs, this.#tabId);
    if (tab === undefined) {
      return { status: "error", error: sinkError("invalid-target", `Tab ${this.#tabId} not found in document ${this.#documentId}`) };
    }
    const { text, spans } = renderSections(sections);
    // Stale outranks equality (docs/CONTRACT.md §2.2): only short-circuit to
    // "unchanged" when the caller's revision still matches what's stored now.
    // Comparing both sides through the same renderer means the lossy Docs
    // round-trip (parseTabToSections drops markdown syntax) never causes a
    // false "changed" — whatever fidelity is lost is lost identically on both
    // operands. This compares .text only, not .spans: a revision that changes
    // only inline styling (e.g. adding **bold** around text that renders the
    // same) is indistinguishable here and reports unchanged. That's the same
    // lossy round-trip as Ruling 2 (parseTabToSections can't recover prior
    // styling to compare against), not a separate gap.
    if (read.value.revisionId === expectedRevision && text === renderSections(parseTabToSections(tab)).text) {
      return { status: "unchanged", revision: read.value.revisionId };
    }
    const requests = buildWriteRequests({ tabId: this.#tabId, bodyEndIndex: tab.bodyEndIndex, text, spans });
    const result = await this.#api.batchUpdate(this.#documentId, requests, expectedRevision);
    if (!result.ok) return writeErrorFor(result.error);
    return { status: "written", revision: result.value.revisionId };
  }
}

/**
 * Lossy on purpose: reconstructs headings/paragraphs/bullets from what read()
 * saw so EnhanceRunner has prior sections to revise and to check `.length > 0`
 * against (src/agent/runner.ts:213-220) — it does not reconstruct bold/link
 * markdown syntax from Docs text-run styling, since core only ever consumes
 * the reconstructed sections as prompt context, not as bytes it round-trips.
 */
function parseTabToSections(tab: DocsTab): readonly Section[] {
  const sections: Section[] = [];
  let current: { heading: string; lines: string[] } | undefined;
  for (const paragraph of tab.paragraphs) {
    if (paragraph.headingLevel !== undefined) {
      if (current !== undefined) sections.push({ heading: current.heading, markdown: current.lines.join("\n") });
      current = { heading: paragraph.text, lines: [] };
      continue;
    }
    if (current === undefined) continue;
    current.lines.push(paragraph.bullet ? `- ${paragraph.text}` : paragraph.text);
  }
  if (current !== undefined) sections.push({ heading: current.heading, markdown: current.lines.join("\n") });
  return sections;
}

function findTab(tabs: readonly DocsTab[], tabId: string): DocsTab | undefined {
  for (const tab of tabs) {
    if (tab.tabId === tabId) return tab;
    const found = findTab(tab.childTabs, tabId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readErrorFor(error: DocsApiError): SinkError {
  if (error.httpStatus === 404) return sinkError("not-found", error.message);
  if (error.httpStatus === 401 || error.httpStatus === 403) return sinkError("forbidden", error.message);
  // 503 is deliberately grouped with 429, not the generic 5xx fallback below:
  // docs/CONTRACT.md §4 calls this out explicitly — a 503 carrying Retry-After
  // is transient backend overload, not a permanent failure.
  if (error.httpStatus === 429 || error.httpStatus === 503) return busySinkError(error.message, error.retryAfterMs);
  return sinkError("transport", error.message);
}

function writeErrorFor(error: DocsApiError): SinkWriteResult {
  if (error.httpStatus === 409 || error.httpStatus === 412) return { status: "stale" };
  if (error.httpStatus === 429 || error.httpStatus === 503) return { status: "busy", ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) };
  if (error.httpStatus === 404) return { status: "error", error: sinkError("not-found", error.message) };
  if (error.httpStatus === 401 || error.httpStatus === 403) return { status: "error", error: sinkError("forbidden", error.message) };
  return { status: "error", error: sinkError("transport", error.message) };
}
```

`read()` reconstructs `sections` via `parseTabToSections` (see the ruling above `read()`'s
implementation) — this was a genuine open point in the spec's "read()" section, resolved by reading
`src/agent/runner.ts:212-220,238`: `EnhanceRunner` does need non-empty `sections` back, both as
prompt context and for its `not-ready`/`characters` short-circuit. `write()`'s `unchanged` detection
(see the other ruling above) depends on this same reconstruction. Both rulings were made and
recorded in the plan before this task was dispatched, not left for the implementer to discover.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/google-docs-sink-unit.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/google/docs-sink.ts test/google-docs-sink-unit.test.ts
git commit -m "feat: add GoogleDocsNoteSink read/write against the GoogleDocsApi port"
```

---

### Task 7: Conformance suite

**Files:**
- Create: `test/google-docs-sink.test.ts`

**Interfaces:**
- Consumes: `GoogleDocsNoteSink` (Task 6), `GoogleDocsApi`/`DocsApiResult`/`DocsTab` types (Task 5),
  `describeNoteSinkConformance`/`SinkHarness` from `shorthand-core/testing`.

**Context:** Spec: "Conformance testing" — `SinkHarness` against a fake Docs server test double,
run through `describeNoteSinkConformance` exactly as `test/markdown-sink.test.ts` does for
`MarkdownNoteSink`. `makeBusy()` is mandatory. `foreignSnapshot()` must assert tabs other than the
owned one are untouched by a write. Build the fake as an in-memory object implementing
`GoogleDocsApi` directly (matching this plan's "no live network" constraint) — no HTTP mocking
library needed, this is exactly the kind of thing a plain in-memory fake handles simply.

**Note:** Task 6's `read()` reconstructs `sections` via `parseTabToSections`, and `write()` uses that
same reconstruction to detect `unchanged`. The `FakeDocsApi` below reconstructs structured
`paragraphs` from the actual `batchUpdate` request array it receives (heading/bullet ranges,
`insertText` offsets) rather than storing a shortcut the fake alone understands — so
`GoogleDocsNoteSink`'s real `read()`/`write()` logic round-trips through it honestly, and the
`alternateSections`/`unchanged`/round-trip conformance scenarios exercise the real reconstruction
path, not a fake-only bypass.

- [ ] **Step 1: Write the fake and wire it into `describeNoteSinkConformance`**

Create `test/google-docs-sink.test.ts`:

```ts
import { describe, test } from "bun:test";
import { describeNoteSinkConformance, type SinkHarness } from "shorthand-core/testing";
import { GoogleDocsNoteSink } from "../src/google/docs-sink.js";
import type { BatchUpdateValue, DocsApiResult, GetDocumentValue, GoogleDocsApi } from "../src/google/docs-client.js";
import type { Section } from "../src/note/markers.js";

const OWNED_TAB = "owned-tab";
const FOREIGN_TAB = "users-own-notes";

type FakeParagraph = { text: string; headingLevel?: 1 | 2 | 3; bullet: boolean };

const NAMED_STYLE_LEVEL: Record<string, 1 | 2 | 3> = { HEADING_1: 1, HEADING_2: 2, HEADING_3: 3 };

class FakeDocsApi implements GoogleDocsApi {
  #revisionId = 1;
  #ownedText = "";
  #ownedParagraphs: FakeParagraph[] = [];
  #foreignText = "unchanged foreign content";
  #forbidden = false;
  #missing = false;
  #busy = false;

  async getDocument(): Promise<DocsApiResult<GetDocumentValue>> {
    if (this.#missing) return { ok: false, error: { httpStatus: 404, message: "not found" } };
    if (this.#forbidden) return { ok: false, error: { httpStatus: 403, message: "forbidden" } };
    if (this.#busy) return { ok: false, error: { httpStatus: 429, retryAfterMs: 500, message: "busy" } };
    return {
      ok: true,
      value: {
        revisionId: String(this.#revisionId),
        tabs: [
          { tabId: OWNED_TAB, bodyEndIndex: this.#ownedText.length + 1, paragraphs: this.#ownedParagraphs, childTabs: [] },
          { tabId: FOREIGN_TAB, bodyEndIndex: this.#foreignText.length + 1, paragraphs: [], childTabs: [] },
        ],
      },
    };
  }

  // Reconstructs paragraphs from the request array the same way a real Google
  // Doc would end up storing them, so GoogleDocsNoteSink.read() (and its
  // unchanged-detection in write()) round-trips through this fake honestly
  // rather than through a shortcut only the fake understands.
  async batchUpdate(_documentId: string, requests: readonly unknown[], targetRevisionId?: string): Promise<DocsApiResult<BatchUpdateValue>> {
    if (this.#busy) return { ok: false, error: { httpStatus: 429, retryAfterMs: 500, message: "busy" } };
    if (targetRevisionId !== undefined && targetRevisionId !== String(this.#revisionId)) {
      return { ok: false, error: { httpStatus: 409, message: "stale" } };
    }
    type Req = {
      insertText?: { location: { index: number; tabId?: string }; text: string };
      updateParagraphStyle?: { range: { startIndex: number; endIndex: number; tabId?: string }; paragraphStyle: { namedStyleType: string } };
      createParagraphBullets?: { range: { startIndex: number; endIndex: number; tabId?: string } };
      deleteContentRange?: { range?: { tabId?: string } };
    };
    const typed = requests as readonly Req[];
    const insertText = typed.find((request) => request.insertText)?.insertText;
    const hasDelete = typed.some((request) => request.deleteContentRange !== undefined);
    // Every request in one batch carries the same tabId (buildWriteRequests
    // stamps it via assertHasTabId). Read it off whichever request happens to
    // be present, and route the write accordingly — this is what gives
    // foreignSnapshot() real teeth: a regression that ever emitted a request
    // against the wrong tab would land in #foreignText and be observable,
    // instead of #foreignText being structurally incapable of changing.
    const targetTabId =
      insertText?.location.tabId ??
      typed.find((request) => request.deleteContentRange)?.deleteContentRange?.range?.tabId ??
      typed.find((request) => request.updateParagraphStyle)?.updateParagraphStyle?.range.tabId ??
      typed.find((request) => request.createParagraphBullets)?.createParagraphBullets?.range.tabId;
    if (targetTabId !== undefined && targetTabId !== OWNED_TAB) {
      if (insertText !== undefined) this.#foreignText = insertText.text;
      else if (hasDelete) this.#foreignText = "";
      this.#revisionId += 1;
      return { ok: true, value: { revisionId: String(this.#revisionId) } };
    }
    if (insertText === undefined && hasDelete) {
      this.#ownedText = "";
      this.#ownedParagraphs = [];
    }
    if (insertText !== undefined) {
      const baseIndex = insertText.location.index;
      let offset = 0;
      const lines: { text: string; start: number; end: number }[] = [];
      for (const rawLine of insertText.text.split("\n")) {
        const start = baseIndex + offset;
        lines.push({ text: rawLine, start, end: start + rawLine.length });
        offset += rawLine.length + 1;
      }
      const headingRequests = typed.filter((request) => request.updateParagraphStyle);
      const bulletRequests = typed.filter((request) => request.createParagraphBullets);
      this.#ownedParagraphs = lines
        .filter((line) => line.text.length > 0)
        .map((line) => {
          const heading = headingRequests.find((request) => {
            const range = request.updateParagraphStyle!.range;
            return range.startIndex <= line.start && range.endIndex >= line.end;
          });
          const bullet = bulletRequests.some((request) => {
            const range = request.createParagraphBullets!.range;
            return range.startIndex <= line.start && range.endIndex >= line.end;
          });
          const level = heading !== undefined ? NAMED_STYLE_LEVEL[heading.updateParagraphStyle!.paragraphStyle.namedStyleType] : undefined;
          return { text: line.text, ...(level === undefined ? {} : { headingLevel: level }), bullet };
        });
      this.#ownedText = insertText.text;
    }
    this.#revisionId += 1;
    return { ok: true, value: { revisionId: String(this.#revisionId) } };
  }

  mutateExternally(): void { this.#revisionId += 1; }
  makeBusy(): void { this.#busy = true; }
  clearBusy(): void { this.#busy = false; }
  makeMissing(): void { this.#missing = true; }
  makeForbidden(): void { this.#forbidden = true; }
  snapshot(): string { return `${this.#ownedText}|${this.#foreignText}`; }
  foreignSnapshot(): string { return this.#foreignText; }
}

const SECTIONS: readonly Section[] = [{ heading: "Summary", markdown: "First." }];
const ALTERNATE: readonly Section[] = [{ heading: "Decisions", markdown: "Second." }];

describeNoteSinkConformance(
  { describe, test },
  "GoogleDocsNoteSink",
  async (): Promise<SinkHarness> => {
    const api = new FakeDocsApi();
    return {
      sink: new GoogleDocsNoteSink({ documentId: "doc1", tabId: OWNED_TAB, api }),
      sections: SECTIONS,
      alternateSections: ALTERNATE,
      // An empty heading can't be represented as a section boundary
      // parseTabToSections could ever recover — GoogleDocsNoteSink.write()
      // refuses it up front with invalid-content before rendering or calling
      // the API (see the write() ruling: this check lives in docs-sink.ts).
      invalidSections: [{ heading: "", markdown: "x" }],
      mutateExternally: async () => api.mutateExternally(),
      makeBusy: async () => {
        api.makeBusy();
        return async () => api.clearBusy();
      },
      makeMissing: async () => api.makeMissing(),
      makeForbidden: async () => api.makeForbidden(),
      snapshot: () => Promise.resolve(api.snapshot()),
      foreignSnapshot: () => Promise.resolve(api.foreignSnapshot()),
    };
  },
  { missing: true, forbidden: true },
);
```

Reconcile `invalidSections` (`{ heading: "", markdown: "x" }`) against whatever validation
`GoogleDocsNoteSink.write()` actually performs — Task 6's implementation above does not currently
reject an empty heading; either add that validation to `GoogleDocsNoteSink.write()` (return
`{ status: "error", error: sinkError("invalid-content", ...) }` before calling the renderer) or
pick a different `invalidSections` case the sink genuinely refuses (e.g. something the renderer
itself cannot represent). Per `docs/CONTRACT.md` §5.3, this field is required to be "sections this
sink must refuse with `error` rather than store" — don't leave it unreconciled.

- [ ] **Step 2: Run the conformance suite**

Run: `bun test test/google-docs-sink.test.ts`
Expected: PASS for every scenario (or documented `test.todo` for anything genuinely inapplicable —
check `NOTE_SINK_CONFORMANCE_SCENARIOS`' `requires` flags against the `{ missing: true, forbidden:
true }` support declared above).

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/google-docs-sink.test.ts src/google/docs-sink.ts
git commit -m "test: run the NoteSink conformance suite against GoogleDocsNoteSink"
```

---

### Task 8: `FileTokenProvider` and the OAuth helpers

**Files:**
- Create: `src/google/oauth.ts`
- Create: `src/google/file-token-provider.ts`
- Test: `test/google-oauth.test.ts`
- Test: `test/google-file-token-provider.test.ts`

**Interfaces:**
- Consumes: `shorthandConfigDirectory` (Task 1), `TokenProvider`/`tokenError` (Task 2).
- Produces:
  ```ts
  // oauth.ts
  export type PkceChallenge = Readonly<{ codeVerifier: string; codeChallenge: string }>;
  export function generatePkceChallenge(client: OAuth2Client): Promise<PkceChallenge>;
  export function buildAuthorizationUrl(options: Readonly<{
    clientId: string; redirectUri: string; codeChallenge: string; scope: string;
  }>): string;
  export type LoopbackResult = Readonly<{ code: string; pickedFileIds: readonly string[] }>;
  export function listenForRedirect(port: number): Promise<LoopbackResult>;
  export type ExchangedTokens = Readonly<{ refreshToken: string }>;
  export function exchangeCode(
    client: OAuth2Client, code: string, codeVerifier: string, redirectUri: string,
  ): Promise<ExchangedTokens>;

  // file-token-provider.ts
  export type GoogleCredentials = Readonly<{ refreshToken: string; documentId: string; tabId?: string }>;
  export type FileTokenProviderOptions = Readonly<{
    clientId: string; clientSecret: string; credentialsPath?: string;
  }>;
  export class FileTokenProvider implements TokenProvider { constructor(options: FileTokenProviderOptions); getAccessToken(): Promise<TokenResult>; }
  export function credentialsPath(environment?: NodeJS.ProcessEnv): string;
  export function writeCredentials(credentials: GoogleCredentials, path?: string): Promise<void>;
  export function readCredentials(path?: string): Promise<GoogleCredentials | undefined>;
  ```
- Consumed by: Task 9's `google-login` CLI subcommand.

**Context:** Spec: "CLI bootstrap: `google-login` and the reference `FileTokenProvider`". Use
`google-auth-library`'s `OAuth2Client` for the parts it already does correctly — PKCE generation
(`generateCodeVerifierAsync()`) and token exchange/refresh (`getToken()`, `refreshAccessToken()`/
`getAccessToken()`) — rather than hand-rolling crypto or refresh_token POST requests.
`trigger_onepick`, `allow_multiple`, and `picked_file_ids` are Google Picker-specific parameters
`OAuth2Client.generateAuthUrl()`'s typed options don't model; build that part of the URL directly
with `URLSearchParams` rather than fighting the typed wrapper — this is plain query-string
construction, not something worth a library. The loopback HTTP listener uses Node's built-in
`node:http` — no third-party server package needed for a single-request local listener.

Credentials file: `chmod 0600` JSON at `join(shorthandConfigDirectory(), "google-credentials.json")`
containing `{ refreshToken, documentId, tabId? }`. **`clientId`/`clientSecret` are not stored in
this file** — they identify the *application* (baked into the binary per the spec's "Desktop OAuth
needs no backend" fact), not the user's credential, and are supplied to `FileTokenProvider`'s
constructor by whatever wires it up (Task 9's CLI, reading `GOOGLE_OAUTH_CLIENT_ID`/
`GOOGLE_OAUTH_CLIENT_SECRET` env vars for now — see Task 9's note on why these aren't hardcoded).

- [ ] **Step 1: Write the failing OAuth helper tests**

Create `test/google-oauth.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { buildAuthorizationUrl, generatePkceChallenge, listenForRedirect } from "../src/google/oauth.js";

describe("generatePkceChallenge", () => {
  test("produces a verifier and a derived S256 challenge", async () => {
    const challenge = await generatePkceChallenge(new OAuth2Client());
    expect(challenge.codeVerifier.length).toBeGreaterThan(40);
    expect(challenge.codeChallenge.length).toBeGreaterThan(0);
    expect(challenge.codeChallenge).not.toBe(challenge.codeVerifier);
  });
});

describe("buildAuthorizationUrl", () => {
  test("includes PKCE, offline access, consent prompt, and the one-pick trigger", () => {
    const url = new URL(buildAuthorizationUrl({
      clientId: "client-1", redirectUri: "http://127.0.0.1:9999/callback",
      codeChallenge: "challenge-abc", scope: "https://www.googleapis.com/auth/drive.file",
    }));
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9999/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("trigger_onepick")).toBe("true");
  });

  test("never includes a second scope alongside drive.file", () => {
    const url = new URL(buildAuthorizationUrl({
      clientId: "c", redirectUri: "http://127.0.0.1:9999/callback",
      codeChallenge: "x", scope: "https://www.googleapis.com/auth/drive.file",
    }));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
  });
});

describe("listenForRedirect", () => {
  test("captures the auth code and picked_file_ids from the redirect query string", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP port");
    server.close();

    const pending = listenForRedirect(address.port);
    await fetch(`http://127.0.0.1:${address.port}/?code=auth-code-1&picked_file_ids=doc-abc`);
    const result = await pending;
    expect(result).toEqual({ code: "auth-code-1", pickedFileIds: ["doc-abc"] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/google-oauth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `oauth.ts`**

Create `src/google/oauth.ts`:

```ts
import { createServer } from "node:http";
import type { OAuth2Client } from "google-auth-library";

export type PkceChallenge = Readonly<{ codeVerifier: string; codeChallenge: string }>;

export async function generatePkceChallenge(client: OAuth2Client): Promise<PkceChallenge> {
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  return { codeVerifier, codeChallenge };
}

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

export type LoopbackResult = Readonly<{ code: string; pickedFileIds: readonly string[] }>;

export function listenForRedirect(port: number): Promise<LoopbackResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(code === null ? "Missing authorization code." : "You may close this tab and return to Shorthand.");
      server.close();
      if (code === null) {
        rejectPromise(new Error(`OAuth redirect missing code: ${url.search}`));
        return;
      }
      const pickedFileIds = url.searchParams.get("picked_file_ids")?.split(",").filter((id) => id.length > 0) ?? [];
      resolvePromise({ code, pickedFileIds });
    });
    server.on("error", rejectPromise);
    server.listen(port, "127.0.0.1");
  });
}

export type ExchangedTokens = Readonly<{ refreshToken: string }>;

export async function exchangeCode(
  client: OAuth2Client,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<ExchangedTokens> {
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  if (tokens.refresh_token === null || tokens.refresh_token === undefined) {
    throw new Error("Google did not return a refresh token — retry with prompt=consent (already set) on a fresh consent grant.");
  }
  return { refreshToken: tokens.refresh_token };
}
```

- [ ] **Step 4: Run OAuth tests and typecheck**

Run: `bun test test/google-oauth.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Write the failing `FileTokenProvider` tests**

Create `test/google-file-token-provider.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTokenProvider, readCredentials, writeCredentials } from "../src/google/file-token-provider.js";

async function scratchPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "google-token-"));
  return join(directory, "google-credentials.json");
}

describe("writeCredentials / readCredentials", () => {
  test("round-trips and is written with 0600 permissions", async () => {
    const path = await scratchPath();
    await writeCredentials({ refreshToken: "rt-1", documentId: "doc-1", tabId: "tab-1" }, path);
    expect(await readCredentials(path)).toEqual({ refreshToken: "rt-1", documentId: "doc-1", tabId: "tab-1" });
    if (process.platform !== "win32") {
      const stats = await import("node:fs/promises").then((fs) => fs.stat(path));
      expect(stats.mode & 0o777).toBe(0o600);
    }
    await rm(path, { force: true });
  });

  test("readCredentials returns undefined when the file does not exist", async () => {
    expect(await readCredentials(await scratchPath())).toBeUndefined();
  });
});

describe("FileTokenProvider.getAccessToken", () => {
  test("returns not-authorized when no credentials file exists yet", async () => {
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: await scratchPath(),
    });
    const result = await provider.getAccessToken();
    expect(result).toEqual({ ok: false, error: { code: "not-authorized", message: expect.any(String) } });
  });

  test("exchanges the stored refresh token for an access token", async () => {
    const path = await scratchPath();
    await writeCredentials({ refreshToken: "rt-1", documentId: "doc-1" }, path);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      // Test seam: injected refresher, not a live OAuth2Client, per the plan's
      // "no live network in any test" constraint.
      refreshAccessToken: async (refreshToken: string) => {
        expect(refreshToken).toBe("rt-1");
        return { ok: true, token: "access-token-1" };
      },
    } as never);
    expect(await provider.getAccessToken()).toEqual({ ok: true, token: "access-token-1" });
  });

  test("maps invalid_grant to revoked", async () => {
    const path = await scratchPath();
    await writeCredentials({ refreshToken: "rt-1", documentId: "doc-1" }, path);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      refreshAccessToken: async () => { throw Object.assign(new Error("invalid_grant"), { code: "invalid_grant" }); },
    } as never);
    expect(await provider.getAccessToken()).toEqual({ ok: false, error: { code: "revoked", message: expect.any(String) } });
  });

  test("maps a network failure to transport", async () => {
    const path = await scratchPath();
    await writeCredentials({ refreshToken: "rt-1", documentId: "doc-1" }, path);
    const provider = new FileTokenProvider({
      clientId: "c", clientSecret: "s", credentialsPath: path,
      refreshAccessToken: async () => { throw new Error("ENOTFOUND"); },
    } as never);
    expect(await provider.getAccessToken()).toEqual({ ok: false, error: { code: "transport", message: expect.any(String) } });
  });
});
```

Add a `refreshAccessToken` test seam to `FileTokenProviderOptions` in Step 6 below (an injectable
function taking a refresh token and returning a `TokenResult`, defaulting to a real
`OAuth2Client`-backed implementation) — the same "test seam only, production always uses the real
thing" pattern `MarkdownNoteSink` uses for `readNote`/`write`.

- [ ] **Step 6: Implement `file-token-provider.ts`**

Create `src/google/file-token-provider.ts`:

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { shorthandConfigDirectory } from "../config.js";
import { tokenError, type TokenProvider, type TokenResult } from "../auth/token-provider.js";

export type GoogleCredentials = Readonly<{ refreshToken: string; documentId: string; tabId?: string }>;

export function credentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(shorthandConfigDirectory(environment), "google-credentials.json");
}

export async function writeCredentials(credentials: GoogleCredentials, path = credentialsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2), "utf8");
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function readCredentials(path = credentialsPath()): Promise<GoogleCredentials | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as GoogleCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export type FileTokenProviderOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  credentialsPath?: string;
  /** Test seam only; production always exchanges the refresh token via OAuth2Client. */
  refreshAccessToken?: (refreshToken: string) => Promise<TokenResult>;
}>;

export class FileTokenProvider implements TokenProvider {
  readonly #path: string;
  readonly #refresh: (refreshToken: string) => Promise<TokenResult>;

  constructor(options: FileTokenProviderOptions) {
    this.#path = options.credentialsPath ?? credentialsPath();
    this.#refresh = options.refreshAccessToken ?? defaultRefresher(options.clientId, options.clientSecret);
  }

  async getAccessToken(): Promise<TokenResult> {
    const credentials = await readCredentials(this.#path);
    if (credentials === undefined) {
      return { ok: false, error: tokenError("not-authorized", `No Google credentials at ${this.#path}; run \`shorthand-notes google-login\` first.`) };
    }
    return this.#refresh(credentials.refreshToken);
  }
}

function defaultRefresher(clientId: string, clientSecret: string): (refreshToken: string) => Promise<TokenResult> {
  return async (refreshToken: string): Promise<TokenResult> => {
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials({ refresh_token: refreshToken });
    try {
      const { token } = await client.getAccessToken();
      if (token === null || token === undefined) {
        return { ok: false, error: tokenError("transport", "Token refresh returned no access token") };
      }
      return { ok: true, token };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "invalid_grant") return { ok: false, error: tokenError("revoked", "Google revoked this credential; run google-login again", error) };
      return { ok: false, error: tokenError("transport", error instanceof Error ? error.message : String(error), error) };
    }
  };
}
```

- [ ] **Step 7: Run all Task 8 tests and typecheck**

Run: `bun test test/google-oauth.test.ts test/google-file-token-provider.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/google/oauth.ts src/google/file-token-provider.ts test/google-oauth.test.ts test/google-file-token-provider.test.ts
git commit -m "feat: add PKCE/OAuth helpers and the reference FileTokenProvider"
```

---

### Task 9: `shorthand-core/google` entry point and the `google-login` CLI

**Files:**
- Create: `src/google.ts`
- Modify: `package.json` (`exports` map)
- Modify: `bin/shorthand-notes.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**
- Produces (public, `shorthand-core/google`):
  `GoogleDocsNoteSink`, `GoogleDocsNoteSinkOptions`, `GOOGLE_DOCS_SCOPE` (Task 6);
  `FileTokenProvider`, `FileTokenProviderOptions`, `GoogleCredentials` (Task 8);
  `GoogleApiDocsClient`, `GoogleDocsApi` (Task 5) — needed by any consumer wiring a real sink
  outside the CLI (e.g. a future desktop app).
- Produces (CLI): `shorthand-notes google-login [--port <n>] [--client-id <id>] [--client-secret <secret>]`

**Context:** Spec: "Package layout", "CLI bootstrap: `google-login`...". Mirrors
`shorthand-core/markdown` → `src/markdown.ts` exactly. The CLI subcommand performs the full
loopback + PKCE + Picker consent round-trip and writes the resulting credentials file — this *is*
open question 1's prototype, not a separate throwaway script, per the spec.

**On `clientId`/`clientSecret`:** these identify Shorthand's own Google Cloud OAuth client, not a
per-user secret. No such client exists yet — creating one requires a Google Cloud Console project,
which is outside what an autonomous coding task can do. For now, read them from
`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` environment variables (or `--client-id`/
`--client-secret` flags) and fail with a clear message if neither is set when `google-login`
actually runs — do not hardcode placeholder values. This is the same shape of gap Task 11 exists to
close (a human needs to create the GCP project and supply real values before this command can be
run end-to-end).

- [ ] **Step 1: Create the `shorthand-core/google` entry point**

Create `src/google.ts`:

```ts
/**
 * The Google Docs sink and its supporting reference implementations, behind
 * the same "own subpath, never imported by anything else in core" pattern
 * markdown.ts established for MarkdownNoteSink.
 */

export { GoogleDocsNoteSink, GOOGLE_DOCS_SCOPE } from "./google/docs-sink.js";
export type { GoogleDocsNoteSinkOptions } from "./google/docs-sink.js";

export { GoogleApiDocsClient } from "./google/docs-client.js";
export type { DocsApiError, DocsApiResult, GoogleDocsApi } from "./google/docs-client.js";

export { FileTokenProvider, credentialsPath, readCredentials, writeCredentials } from "./google/file-token-provider.js";
export type { FileTokenProviderOptions, GoogleCredentials } from "./google/file-token-provider.js";
```

- [ ] **Step 2: Register the subpath in `package.json`**

In `package.json`'s `"exports"` object, add (matching the existing `"./markdown"` entry style):

```json
"./google": "./src/google.ts",
```

- [ ] **Step 3: Write the failing CLI argument-parsing test**

Add to `test/cli.test.ts` (check the existing file first for its harness pattern — it likely
invokes `runCli` with an injected environment/stdout capture; match that pattern rather than
inventing a new one):

```ts
test("google-login requires a client id and secret from flags or environment", async () => {
  const exitCode = await runCli(["google-login"], {});
  expect(exitCode).toBe(2);
});

test("google-login accepts --client-id and --client-secret", async () => {
  // Full OAuth round-trip needs a real browser + Google consent; this only proves
  // argument parsing accepts the flags and does not immediately usage-error.
  // Use HANDY_NOTES_GOOGLE_LOGIN_STUB (added below) to short-circuit the actual
  // browser-open + token-exchange steps in a test environment.
});
```

Read the existing `test/cli.test.ts` for how other subcommands are tested end-to-end (e.g.
`init-note`, `read-block`) and follow that exact pattern rather than the sketch above — adjust
before running.

- [ ] **Step 4: Wire the subcommand into `bin/shorthand-notes.ts`**

Add `"google-login"` to the `runCli` dispatch (`bin/shorthand-notes.ts`'s `runCli` function) and to
the `usage()` string. Add a new function:

```ts
async function runGoogleLogin(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const clientId = argumentValue(args, "--client-id") ?? environment.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = argumentValue(args, "--client-secret") ?? environment.GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) {
    return usage("google-login requires --client-id/--client-secret or GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET.");
  }
  const port = Number(argumentValue(args, "--port") ?? "0") || 8721;
  const { OAuth2Client } = await import("google-auth-library");
  const client = new OAuth2Client({ clientId, clientSecret });
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { generatePkceChallenge, buildAuthorizationUrl, listenForRedirect, exchangeCode } = await import("../src/google/oauth.js");
  const { writeCredentials } = await import("../src/google/file-token-provider.js");
  const { GOOGLE_DOCS_SCOPE } = await import("../src/google/docs-sink.js");

  const { codeVerifier, codeChallenge } = await generatePkceChallenge(client);
  const authorizationUrl = buildAuthorizationUrl({ clientId, redirectUri, codeChallenge, scope: GOOGLE_DOCS_SCOPE });
  console.log(`Opening your browser to authorize Shorthand:\n${authorizationUrl}`);
  await openInBrowser(authorizationUrl, environment);

  const redirect = await listenForRedirect(port);
  const documentId = redirect.pickedFileIds[0];
  if (documentId === undefined) {
    console.error("No document was picked. Re-run google-login and choose a Google Doc.");
    return 1;
  }
  const { refreshToken } = await exchangeCode(client, redirect.code, codeVerifier, redirectUri);
  await writeCredentials({ refreshToken, documentId });
  console.log(`Google account connected. Target document: ${documentId}`);
  console.log("Run `shorthand-notes enhance` with a Google Docs sink to start writing to it.");
  return 0;
}

async function openInBrowser(url: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const commandArgs = process.platform === "win32" ? ["/c", "start", '""', url] : [url];
  spawn(command, commandArgs, { stdio: "ignore", detached: true }).unref();
}
```

Add `"google-login"` to the dispatch in `runCli`:

```ts
if (command === "google-login") return await runGoogleLogin(args, environment);
```

Add `"--client-id", "--client-secret", "--port"` to `KNOWN_FLAGS`.

- [ ] **Step 5: Run the CLI tests**

Run: `bun test test/cli.test.ts`
Expected: PASS for the argument-validation test written in Step 3. A full end-to-end run of
`google-login` cannot be part of the automated suite — it opens a real browser and requires a human
to grant consent — so no test here exercises past the point of listening for the redirect.

- [ ] **Step 6: Full suite, typecheck, lint, build**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS. The `build` step matters here specifically because `esbuild`'s bundling of
`bin/shorthand-notes.ts` needs to succeed with the new dynamic imports and dependencies.

- [ ] **Step 7: Commit**

```bash
git add src/google.ts package.json bin/shorthand-notes.ts test/cli.test.ts
git commit -m "feat: add shorthand-core/google entry point and the google-login CLI"
```

---

### Task 10: Scope-creep CI guard

**Files:**
- Create: `test/google-scope-guard.test.ts`

**Interfaces:**
- None — this is a static-analysis test with no runtime dependency on prior tasks beyond the
  presence of `GOOGLE_DOCS_SCOPE` as a source-level string literal.

**Context:** Spec: "Scope invariant" — "Recommend a CI check... rather than relying on code review
alone." Grep the whole `src/` and `bin/` tree for `googleapis.com/auth/` occurrences and assert
every one is exactly `.../auth/drive.file`.

- [ ] **Step 1: Write the test**

Create `test/google-scope-guard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function allSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return allSourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat();
}

describe("Google OAuth scope guard", () => {
  test("no source file requests a googleapis.com/auth/ scope other than drive.file", async () => {
    const files = [...await allSourceFiles("src"), ...await allSourceFiles("bin")];
    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const matches = content.match(/googleapis\.com\/auth\/[\w.]+/g) ?? [];
      for (const match of matches) {
        if (match !== "googleapis.com/auth/drive.file") offenders.push(`${file}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test test/google-scope-guard.test.ts`
Expected: PASS (it should find exactly the one occurrence in `src/google/docs-sink.ts`'s
`GOOGLE_DOCS_SCOPE` constant and nothing else).

- [ ] **Step 3: Commit**

```bash
git add test/google-scope-guard.test.ts
git commit -m "test: guard against Google OAuth scope creep beyond drive.file"
```

---

### Task 11: Live-prototype verification (manual gate — not autonomous)

**This task cannot be executed by a coding subagent.** It requires a real Google Cloud project with
an OAuth 2.0 Desktop client (client ID + secret) and a human to complete a browser consent flow —
credentials this plan's execution environment does not have and cannot create on its own (creating
a GCP project/OAuth client is an action in the user's Google account, not a code change). **Flag
this back to the user rather than skipping or faking it.**

Once a human has created a test Google Cloud project and OAuth Desktop client and shared the
client ID/secret (as environment variables, not committed anywhere):

- [ ] **Step 1:** `GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... bun bin/shorthand-notes.ts google-login`
  against the real Google Cloud project. Confirms spec open question 1 (loopback + `trigger_onepick`
  actually work together) and exercises the whole Task 8/9 code path against real Google endpoints.
- [ ] **Step 2:** With the resulting credentials, manually run one `batchUpdate` containing an
  `addDocumentTab` request against the picked document (a short one-off script using
  `GoogleApiDocsClient` and `FileTokenProvider` together is enough — it does not need to be
  committed). Confirms spec open question 2. Record the exact reply shape actually returned and
  reconcile it against Task 5's `GetDocumentValue`/whatever `addDocumentTab` reply-parsing this
  surfaced as necessary — update `src/google/docs-client.ts` and its tests if the real shape
  differs from what typechecking alone caught.
- [ ] **Step 3:** Call `about.get` under the `drive.file`-scoped token obtained in Step 1 and check
  whether the user's email is present in the response. Confirms spec open question 4 (informational
  for future account-linking work, not blocking for 1a/1b).
- [ ] **Step 5:** Record the outcome of all four checks in a short note under
  `docs/superpowers/` (e.g. append a "Prototype verification results" section to the spec file
  itself) so this doesn't need re-deriving later, and open follow-up tasks for anything Step 2 or
  Step 3 revealed needs a code change.

---

## Self-Review Notes

- **Spec coverage:** `TokenProvider` port (Task 2), package layout (Tasks 2/6/9), renderer (Task 3),
  `write()`'s request shape/ordering (Task 4), `read()`/`write()`/concurrency/error-mapping (Task 6),
  conformance testing (Task 7), `google-login`/`FileTokenProvider` (Tasks 8/9), scope invariant
  (Tasks 6/10), open questions (Task 11). "Meeting start" (`addDocumentTab`) is intentionally
  deferred to Task 11's manual prototype rather than given an untestable automated task — see
  Task 6's note.
- **Resolved before dispatch, not left open:** whether `GoogleDocsNoteSink.read()` needs to parse
  Docs content back into non-empty `Section[]` — yes, confirmed against `src/agent/runner.ts`
  (`observed.sections` feeds the prompt and a `.length > 0` short-circuit). This also surfaced that
  the original `write()` draft never implemented the `unchanged` outcome `docs/CONTRACT.md` §2.2
  requires and the conformance suite asserts — both are now fixed in Tasks 5-7 (`DocsTab.paragraphs`,
  `parseTabToSections`, the `renderSections`-based unchanged comparison, and `FakeDocsApi`
  reconstructing paragraphs from real request shapes rather than a shortcut). Both rulings and their
  rationale are recorded inline in Tasks 5-7 above, and are lossy-round-trip-aware: bold/link
  markdown syntax is not reconstructed from Docs styling, only plain text/headings/bullets are —
  acceptable for what `EnhanceRunner` actually consumes, revisit if a later phase needs exact
  round-tripping.
- **`invalidSections` reconciliation** between Task 6's actual validation and Task 7's conformance
  harness is flagged explicitly rather than assumed to match.
- **`addDocumentTab`'s exact request/reply field names** are deliberately left for Task 11 (or an
  earlier task's implementer, if `googleapis`'s shipped types make it unambiguous) to confirm
  against real types/a real document, rather than guessed further in this plan — the spec itself
  says the reference documentation is stale here.
