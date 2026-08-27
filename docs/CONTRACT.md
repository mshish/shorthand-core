# The core contract

This is the contract between `shorthand-core` and a consumer that supplies it with
a destination. It exists for the case that motivated the sink port in the first place: an
**API-backed** target — Notion- or Granola-shaped, with `GET` + etag, `PATCH` with
`If-Match`, `409` for a lost race and `429` for backpressure — rather than a second Markdown
app. If you are writing that sink, this document plus `src/testing/sink-conformance.ts` is
everything you need; you should not have to read core's internals, and if you do, that is a
bug in this document.

Core's side of the deal is narrow and worth stating up front:

> Core decides **what** the AI-owned sections should say. The sink decides **where** they
> live, **how** concurrency is detected, and **what** the surrounding document is. Core never
> touches a path, a marker, a hash, an etag, or an HTTP status.

---

## 1. The public surface

The package's `exports` map is the boundary, and it is enforced at resolution time — `tsc`,
`esbuild` and Node all honour it, so a deep import fails to resolve rather than merely being
frowned upon. There are four entry points.

| Specifier | Contains | Who imports it |
| --- | --- | --- |
| `shorthand-core` | The ports and the engine: `EnhanceRunner`, `NoteSink`, `SidecarStore` and their result types, `Section`, `StreamClient`, `ShorthandControl`, `TranscriptStore`, `SidecarWriter`, the agent clients and configuration helpers | Every consumer |
| `shorthand-core/markdown` | The reference `MarkdownNoteSink`; the transport-free document codec (`readMarkdownDocument`, `updateMarkdownDocument`, `scaffoldMarkdownDocument` and result/edit types); and note-scaffolding helpers (`locateAiBlock`, `transcriptWikilink`, `ensureNoteScaffold`, `linkTranscriptFrontmatter`, `buildNoteScaffold`) | Markdown consumers only. **An API sink must not import this.** |
| `shorthand-core/google` | The Google Docs sink and the pieces it needs: `GoogleDocsNoteSink`, `GOOGLE_DOCS_SCOPE`, `GoogleApiDocsClient` and its API types, the credentials reader — `FileTokenProvider`, `credentialsPath`, `readCredentials`, `GoogleCredentials`, `CredentialsReadResult`, `FileTokenProviderOptions` — and `resolveGoogleDocsSink`/`ResolveGoogleSinkOptions`/`ResolveGoogleSinkResult`, which mints or reuses a per-capture tab and constructs the sink | Google Docs consumers only. **A Markdown or other API sink must not import this.** Core reads the credentials file and never writes it; see §5.4 |
| `shorthand-core/testing` | The executable contracts. For the sink port: `NOTE_SINK_CONFORMANCE_SCENARIOS`, `describeNoteSinkConformance`, `SinkHarness`, `SinkHarnessFactory`, `SinkConformanceScenario`, `SinkConformanceSupport`, `ConformanceTestPrimitives`. For Google credentials: `GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS`, `describeGoogleCredentialsConformance`, `GOOGLE_CREDENTIALS_FIXTURES`, `CredentialsWriterHarness`, `CredentialsHarnessFactory`, `CredentialsFixture`, `CredentialsGoldenFixture`, `CredentialsConformanceScenario`, and `CredentialsConformanceSupport`. For LLM credentials: `LLM_CREDENTIALS_CONFORMANCE_SCENARIOS`, `describeLlmCredentialsConformance`, `LLM_CREDENTIALS_FIXTURES`, `LlmCredentialsWriterHarness`, `LlmCredentialsHarnessFactory`, `LlmCredentialsFixture`, `LlmCredentialsGoldenFixture`, `LlmCredentialsConformanceScenario`, and `LlmCredentialsConformanceSupport` | Any sink's test suite; any writer of either credentials file |

`parseTemplateSections` is on the root entry point rather than `shorthand-core/markdown`
even though its output is fed to `ensureNoteScaffold`: the starting sections of a note are
not a Markdown concern, and an API-backed sink needs them just as much. What it validates is
the section contract — `MAX_SECTIONS`, `MAX_HEADING_CHARACTERS`, the marker-token ban — which
is also not Markdown-specific.

Entry points are **explicit named re-exports**, never `export *`. `export *` would drag every
incidental module on the re-exported files' graph into consumers' bundles — the Obsidian
plugin's bundle is already ~7 MB — and would silently widen the public surface each time some unrelated
module gained an export.

### What is deliberately NOT exported, and why

These are not oversights. Each one is either a **block-format internal** or a **test seam**,
and exporting it would re-create precisely the coupling the sink port was built to remove.

| Not exported | Why |
| --- | --- |
| `readCurrentBlock`, `writeSections` | The pre-port coupling itself. Their signatures leak filesystem paths *and* the Markdown block-hash model. A consumer reaching for these is a consumer bypassing `NoteSink`. |
| `hashBlock` | Revision is opaque (§2.3). An exported hash function invites a sink to derive "the" revision the Markdown way, and invites core to grow an assumption it can. |
| `parseSections`, `extractUserNotes` | Low-level pieces of the public Markdown document codec. Consumers use `readMarkdownDocument` so parsing, user notes, and revision come from the same observation. |
| `AI_BLOCK_START` / `AI_BLOCK_END`, `detectLineEnding` | Marker comments and CRLF are file-format concerns. A Notion page has neither. |
| `NdjsonDecoder` | An internal of `StreamClient`'s transport. |
| `buildClaudeAgentOptions`, `createVaultToolGuard`, `ExecutableAgentStub` | Test seams and agent-wiring internals. `ExecutableAgentStub` in particular exists so tests can run without a `claude` binary; shipping it would make it API. |

If you find yourself wanting one of these, the answer is almost always that a **capability is
missing from `NoteSink`** and should be added to the port — not that the internal should be
exported.

### Transactional sidecar stores

`SidecarWriter` accepts a storage port when the transcript does not live on the ordinary
filesystem:

```ts
interface SidecarStore {
  readonly describe: string;
  process<T>(
    transform: (current: string | undefined) => Readonly<{ content: string; value: T }>,
  ): Promise<T>;
}
```

`undefined` means the target is missing. The callback is synchronous and pure because a store
*may* invoke it again when that store provides optimistic concurrency. If it throws, the store
must leave the target unchanged. On success, `process` returns the `value` from the invocation
whose `content` it committed, never from a discarded attempt. Serialization, retry, and
cross-process concurrency guarantees are store-specific; the interface does not manufacture
them. The default filesystem adapter is the generic/headless Markdown transport and retains
best-effort temp-write/rename behavior, including the residual external-write window documented
in `DESIGN.md`. An Obsidian adapter should implement this port with `Vault.process`, whose atomic
callback supplies the stronger boundary. `describe` is the human-readable target used by status
and errors. Supplying both `store` and the legacy filesystem test seam is rejected because it
would make persistence ownership ambiguous.

A second hole the `exports` map cannot see: a **relative** import that escapes a consumer's
own root (`../../src/note/writer.js`) bypasses bare-specifier resolution entirely. **Nothing
closes it today.** `test/consumer-imports.test.ts` used to, by scanning consumer roots for
relative specifiers that resolved outside the consumer; it went when the Obsidian plugin moved
to its own repository, because a consumer in another repo has no root inside this one left to
escape (`docs/DESIGN.md`). Vendoring a consumer back into this tree would reopen the hole and
would need that test back.

### `enhanceNow` can be told the empty transcript is deliberate

```ts
enhanceNow(tier: AgentTier = "link", options?: Readonly<{ allowEmptyTranscript?: boolean }>): Promise<PassOutcome>
```

A `link` pass with no new transcript, against a note that already has sections, is declined
with `{ status: "not-ready", reason: "characters" }` and never reaches the model. That is
right for a capture: the closing pass would be paid for and change nothing.

It is wrong for a note that has no transcript and never will — one written by hand, or
dictated outside a capture. `allowEmptyTranscript: true` says so, and the pass runs against
the note's own prose, which `buildPassPrompt` already sends as `<user_notes>`.

The waiver is per call, not per runner: the same runner declines the next empty `link` pass
unless that call asks too. The default is `false`, which is what leaves every existing call
site — the capture-stop pass, the CLI's `enhance` command — behaving exactly as before.

---

## 2. The `NoteSink` contract

```ts
export interface NoteSink {
  /** Everything a pass needs, read together so sections and notes share one revision. */
  read(): Promise<SinkReadResult>;
  write(sections: readonly Section[], expectedRevision: string): Promise<SinkWriteResult>;
  /** Where the agent may look for related context. Absent for API sinks. */
  readonly agentContext?: { cwd: string };
  /** Human-readable target, for status and logs. */
  readonly describe: string;
}

type SinkSnapshot = Readonly<{
  sections: readonly Section[];
  userNotes: string;
  revision: string;
}>;

type SinkReadResult =
  | { ok: true; value: SinkSnapshot }
  | { ok: false; error: SinkError };

type SinkWriteResult =
  | { status: "written"; revision: string }
  | { status: "unchanged"; revision: string }
  | { status: "stale" }
  | { status: "busy"; retryAfterMs?: number }
  | { status: "error"; error: SinkError };

type SinkError = Readonly<{
  code: "not-found" | "forbidden" | "invalid-target" | "invalid-content" | "busy" | "transport";
  message: string;
  retryAfterMs?: number;   // backoff hint for `busy`; ignored for every other code
  cause?: unknown;
}>;
```

Construct errors with the exported helpers, `sinkError(code, message, cause?)` and
`busySinkError(message, retryAfterMs?, cause?)` — they get `exactOptionalPropertyTypes`
right, which hand-written object literals routinely do not.

### 2.1 `read()` must be ONE read

`read()` returns sections, user notes, **and** revision from a single observation of the
target. This is a hard requirement, not a convenience:

- Core uses `userNotes` as the agent's input and `sections` as the current state to revise.
  If they came from two observations, a user edit landing between them would let the agent
  revise sections that never coexisted with the notes it read.
- `revision` must describe *exactly* the state the other two fields came from, because core
  hands it straight back to `write()` as `expectedRevision`. A revision fetched separately
  can already be superseded at the moment it is returned, which turns optimistic concurrency
  into a coin flip.

For an API sink: one `GET`, and take the etag **from that response**. Do not issue a
`HEAD` for the etag.

`revision` must also be **stable**: two reads with no intervening mutation must return the
same value. A revision derived from wall-clock time or a random nonce passes every other
scenario in the conformance suite and then goes permanently stale in production, because a
pass's read and its write straddle a tick. The suite pins this explicitly.

### 2.2 Write outcomes, and what each one means to core

| Status | Meaning | What core does |
| --- | --- | --- |
| `written` | The sections were stored. `revision` is the new revision. | Records the pass as successful and adopts the returned revision. |
| `unchanged` | The sections already matched; nothing was stored. `revision` is the current (unmoved) revision. | Treated as a completed pass that wrote nothing. |
| `stale` | `expectedRevision` is superseded. **Nothing was written.** | Discards the agent's result and re-queues. Never a failure; never counted as a permanent failure. |
| `busy` | Transiently unavailable. **Nothing was written.** The *same* call may be retried. | Re-queues, honouring `retryAfterMs` if given. Must never count toward a permanent-failure limit. |
| `error` | A real failure. **Nothing partial was written.** | Surfaces `error.message`; the pass fails. |

Two rules bind the sink here:

- **`stale` outranks equality.** If `expectedRevision` is superseded, return `stale` — even
  when the supplied sections happen to equal what is stored. Concurrency is checked *before*
  content, so `unchanged` always implies the caller held a current revision. Getting this
  backwards makes `unchanged` a lie that hides a lost race.
- **Staleness is not about *who* moved it.** A revision superseded by this sink's own earlier
  write is just as stale as one superseded from outside. Last-writer-wins between two passes
  holding the same revision silently discards the first pass's work.

### 2.3 `revision` is opaque

Core never inspects, parses, compares, orders, or constructs a revision. It reads one from
`read()` and hands that exact string back to `write()`. A content hash, an etag, a monotonic
version number, an opaque cursor — all equally valid. The Markdown sink uses a SHA-256 of the
block body; an API sink should use the etag verbatim, quotes and `W/` prefix included, and
send it back in `If-Match` unmodified.

The only constraint is that it is a **non-empty string** and that it **moves when the target
moves** (see §2.1 on stability).

### 2.4 `agentContext` is optional, and absence is a supported mode

```ts
readonly agentContext?: { cwd: string };
```

`agentContext` says "the agent may look here for related material." For the Markdown sink it
is the vault root, which lets the *link tier* pass use `Read`/`Glob`/`Grep` (confined to that
root by a `canUseTool` guard) to pull in neighbouring notes.

For an API sink there is no such thing, and **it must be omitted** — not faked, not set to
`process.cwd()`. A requested link tier also downgrades independently when the selected
`AgentClient` declares `supportsVaultTools: false`; a searchable target cannot give a
non-agentic provider client a tool loop. When either prerequisite is absent, core degrades
honestly in `EnhanceRunner.#runPass`:

1. **A requested `link` tier is downgraded to `tick`.** A link pass without a searchable
   corpus is just a tick pass with more prompt.
2. **No `cwd` is passed when the sink has no context or the client declines vault tools.**
   A vault-capable client receives the sink's `cwd` on both tiers because its subprocess and
   resumable session are project-scoped even when a tick pass has no tools.

Do not fabricate a directory to "unlock" the link tier. It gives the agent a vault-shaped
tool surface pointed at something that is not the target, which is worse than the downgrade.

### 2.5 `describe`

A non-empty human-readable label for the target — a note path, a page title, a URL. It goes
into status text and logs. It is the only field a user ever sees, so make it identify *which*
target, not merely what kind.

---

## 3. The ownership invariant

**A sink may only own its sections region. A successful write must not disturb anything
else.**

This is the single most important rule in this document, and it is the one that no status
code can express. A sink that replaces its entire target on every write returns `written`
with a fresh revision, round-trips its sections perfectly, and satisfies every other
assertion here — while destroying the user's own prose.

Concretely, after a successful `write()`:

- Everything outside the sections region is **byte-identical** (or, for a structured target,
  block-for-block identical): surrounding page content, the user's notes, neighbouring
  blocks, frontmatter, properties, comments.
- `userNotes` as read back is unchanged.
- Nothing partial survives a failed write. `stale`, `busy`, and `error` must all leave the
  target **exactly** as it was.

For the Markdown sink this is enforced structurally — read, locate markers in *that* content,
splice only the block body, fsync a temp file, rename over the target. For an API sink, the
equivalent discipline is to `PATCH` only the block IDs you own, never to `PUT` the page.

The conformance suite asserts this directly via the `foreignSnapshot()` harness hook, which
is why that hook is mandatory and why it must cover content the sink does **not** own.

---

## 4. The HTTP mapping an API sink needs

The write outcomes were *found* to generalise rather than invented, which is the main evidence
the seam is real. This is the whole translation layer:

| HTTP | `write()` result | `read()` error code |
| --- | --- | --- |
| `409 Conflict` (If-Match failed) | `{ status: "stale" }` | — |
| `412 Precondition Failed` | `{ status: "stale" }` | — |
| `429 Too Many Requests` | `{ status: "busy", retryAfterMs }` from `Retry-After` | `busySinkError(msg, retryAfterMs)` |
| `403 Forbidden` | `{ status: "error", error: sinkError("forbidden", …) }` | `forbidden` |
| `401 Unauthorized` | `forbidden` (it is not retryable by core) | `forbidden` |
| `404 Not Found` | `{ status: "error", error: sinkError("not-found", …) }` | `not-found` |
| `2xx`, body unchanged | `{ status: "unchanged", revision }` | — |
| `2xx`, body stored | `{ status: "written", revision }` | — |
| `5xx`, timeouts, socket errors | `transport` | `transport` |
| Response shape core cannot own (missing block, duplicated region) | `invalid-target` | `invalid-target` |
| Sections that cannot be represented as blocks | `invalid-content` | — |

Notes that are easy to get wrong:

- **`Retry-After` is seconds; `retryAfterMs` is milliseconds.** Multiply. It must be positive
  when present — the conformance suite checks.
- **`503` with `Retry-After` is `busy`, not `transport`.** The distinction is whether core
  should re-queue cheaply or treat the pass as failed.
- **Do not map `429` to `error` with code `busy`** on the *write* path. Return
  `{ status: "busy" }`. The `busy` error *code* is for the read path, where there is no
  status union to carry it.
- **`stale` carries no error.** It is a normal, expected outcome of optimistic concurrency
  under a live meeting, not a problem to report.

The Markdown sink's own mapping (`src/note/markdown-sink.ts:105-110`) is the same table in
filesystem vocabulary: `retry` (outside edits / writer busy) → `busy`, `note-locked` (EPERM
under OneDrive) → `busy` + `retryAfterMs`, hash mismatch → `stale`.

---

## 5. Running the conformance suite

`shorthand-core/testing` is **shipped API, not a test**. It imports no test runner, has
no assertion-library dependency, and every scenario is a plain async function that throws on
failure. That inversion is the whole point: the artifact that defines the contract has to be
runnable by a second package, a different runner, or an extracted core — not only by
`bun test` in this repo.

There are two ways in.

### 5.1 The adapter — hand it your runner's primitives

`describeNoteSinkConformance(primitives, name, createHarness, support?)` registers every
scenario. `primitives` is the minimal slice of a runner it needs: `{ describe, test }`, where
`test` may optionally carry `test.todo`.

**Vitest:**

```ts
import { describe, test } from "vitest";
import { describeNoteSinkConformance, type SinkHarness } from "shorthand-core/testing";
import { NotionNoteSink } from "../src/notion-sink.js";

describeNoteSinkConformance(
  { describe, test },
  "NotionNoteSink",
  async (): Promise<SinkHarness> => {
    const server = await startFakeNotion();          // your test double
    const sink = new NotionNoteSink({ pageId: server.pageId, token: "test" });
    return {
      sink,
      sections: [{ heading: "Summary", markdown: "First." }],
      alternateSections: [{ heading: "Summary", markdown: "Second." }],
      invalidSections: [{ heading: "", markdown: "x" }],   // must be refused, not stored
      mutateExternally: () => server.editPageOutOfBand(),
      makeBusy: async () => {
        server.forceStatus(429, { retryAfter: 1 });
        return async () => server.clearForcedStatus();
      },
      makeMissing: () => server.deletePage(),
      makeForbidden: () => server.revokeAccess(),
      snapshot: () => server.dumpWholePage(),
      foreignSnapshot: () => server.dumpBlocksOutsideOwnedRegion(),
      dispose: () => server.close(),
    };
  },
  { missing: true, forbidden: true },
);
```

**`node:test`** — same call, different primitives (it has no `test.todo`, so unsupported
scenarios are simply omitted):

```ts
import { describe, it } from "node:test";
import { describeNoteSinkConformance } from "shorthand-core/testing";

describeNoteSinkConformance({ describe, test: it }, "NotionNoteSink", createHarness, {
  missing: true,
});
```

**`bun:test`** is how this repo runs it against the reference implementation — see
`test/markdown-sink.test.ts`:

```ts
import { describe, test } from "bun:test";
import { describeNoteSinkConformance } from "shorthand-core/testing";
```

### 5.2 No runner at all — drive the scenarios directly

`NOTE_SINK_CONFORMANCE_SCENARIOS` is the contract as data. Useful in a script, a CI gate, or
any runner whose API does not fit the primitives shape:

```ts
import { NOTE_SINK_CONFORMANCE_SCENARIOS } from "shorthand-core/testing";

const support = { missing: true, forbidden: false };
let failed = 0;
for (const scenario of NOTE_SINK_CONFORMANCE_SCENARIOS) {
  if (scenario.requires !== undefined && support[scenario.requires] !== true) {
    console.log(`skip: ${scenario.name}`);
    continue;
  }
  try {
    await scenario.run(createHarness);
    console.log(`ok:   ${scenario.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${scenario.name}\n      ${(error as Error).message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
```

### 5.3 The harness you must supply

`createHarness` returns a **fresh** harness per scenario — every scenario calls it
independently and disposes it afterwards, so state must not leak between them.

| Field | Requirement |
| --- | --- |
| `sink` | A sink whose target already exists and is readable. |
| `sections` / `alternateSections` | Two different, storable section arrays. |
| `invalidSections` | Sections this sink must refuse with `error` rather than store. If your transport can represent anything, you need a case it cannot — an oversize block, an illegal heading. |
| `mutateExternally()` | Move the target's revision from outside the sink. |
| `makeBusy()` | Put the target into a transient busy state and return the release. **Mandatory** — `busy` is the most transport-specific behaviour in the port, so a sink that cannot demonstrate it has not been tested. |
| `snapshot()` | Opaque snapshot of the **whole** target, compared only for equality. Detects destructive writes. |
| `foreignSnapshot()` | Opaque snapshot of **only** what the sink must never own. This is the ownership invariant's teeth (§3). |
| `makeMissing?()` / `makeForbidden?()` | Optional; declare the matching flag in `support` to enable those scenarios. |
| `dispose?()` | Tear down. |

Capabilities are **declared** in `support` rather than probed, so a transport that cannot
produce a shape appears as a `todo` in the report instead of a silently absent test.

### 5.4 The Google credentials file

`shorthand-core/google` **reads** `google-credentials.json` and never writes it. One writer
per file: a file with two writers has an invariant that lives in neither of them. Core's job
is to define the contract and enforce it executably.

The file is Google's Application Default Credentials `authorized_user` shape — `type`,
`client_id`, `client_secret`, `refresh_token`, which `google-auth-library`'s own
`UserRefreshClient.fromJSON` reads by those names, and which are the only fields a read
validates — plus `document_id` and `folder_id`, which are ours and are both optional. A
credential with no target is still a credential: `document_id` is deliberately unvalidated
by the read here because reading credentials is about credential validity, not target
selection. `resolveGoogleDocsSink` (`src/google/capture-sink.ts`) is the consumer that does
require a target for the `--sink google` path, and reports a clear error when one is absent.
An absent optional field is **omitted**, never `null`. Extra
top-level keys are ignored by Google's loader
and by core, so one superset file works where a sibling file would only re-create a torn
state between two writes. It lives at `credentialsPath()`, is 2-space-indented JSON with a
trailing newline and the key order above, is mode `0600` on non-Windows, and must be written
atomically — temp file in the same directory, then rename.

`describeGoogleCredentialsConformance` registers those requirements against your writer the
same way `describeNoteSinkConformance` does for a sink, with the language boundary at
`write()`; `GOOGLE_CREDENTIALS_FIXTURES` ships the exact expected bytes so a writer in another
language can assert against them without running JavaScript at all.

---

## 6. Consumers

The Obsidian plugin has been extracted to its own repository,
[`mshish/obsidian-shorthand-notes`](https://github.com/mshish/obsidian-shorthand-notes). It consumes
this package the way any second consumer would — by package name, through the `exports` map,
pinned to a tag:

```json
"shorthand-core": "git+https://github.com/mshish/shorthand-core.git#0.1.0"
```

The extraction cost exactly what this document predicted: a directory move plus a dependency
line. Nothing in the sink port, the runner, or the entry points changed. The one thing that
did not survive was `./plugin-ui` — Obsidian settings and a status-bar reducer parked under
`src/` — which was never core's contract and now lives in the plugin repo as ordinary source.

Two properties of this repo constrain any future consumer, and both are deliberate:

- **`bin/` is internal to core, not a consumer.** `read-block` and `set-sections` call
  `readCurrentBlock`/`writeSections` directly. That is legitimate for code inside the package,
  but it makes them Markdown-coupled CLI commands — they could not be lifted into a consumer
  without the block writer coming too.
- **`bin/shorthand-notes.ts` runtime-resolves `../test/fixtures/fake-stream.mjs`** from the bundle
  location, so `dist/` and `test/` must stay siblings at runtime. A consumer that vendors only
  `dist/` loses `--fake-stream`.

Verification needs nothing special: the conformance suite is runner-independent and exported,
so a consumer's own test suite runs it against its own sink with no access to core internals.
