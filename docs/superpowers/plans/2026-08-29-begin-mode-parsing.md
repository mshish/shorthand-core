# `begin.mode` Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `parseWireRecord` understands the `mode` field `shorthand-app` now sends on `begin` records, exposes it on the `begin` variant of `WireEvent`, and drops a value it does not recognize rather than coercing one.

**Architecture:** One new exported string-union type and one new optional field on an existing variant, parsed by a validator that follows the precedent `stringArrayField` set: a present-but-wrong value is dropped, never trusted or coerced, because the plugin gates note-writing behaviour on it. Everything else in the stream path — `TranscriptStore`, `StreamClient`'s session bookkeeping, the sidecar — is untouched: `mode` is metadata a consumer reads off the raw record, not something the transcript machinery uses.

**Tech Stack:** TypeScript, `bun:test`.

**Spec:** `D:/tools/shorthand-repos/shorthand-obsidian-plugin/docs/superpowers/specs/2026-08-29-plugin-ux-improvements-design.md` § 4

## Global Constraints

- **Wire values are exactly `"meeting"`, `"assisted-notes"`, `"dictation"`.** They must match `shorthand-app`'s `FollowMode` serialization character for character.
- **`mode` is optional.** An app that predates the field is a valid, common case for the entire life of this release, exactly as a missing `capabilities` field is. It parses as absent, never as an error.
- **An unrecognized `mode` string is dropped, not passed through.** The rule and its reason are already written down in `stringArrayField`'s doc comment in this same file: "a consumer that gates a control signal on a capability string must never see a value it did not really advertise." The same applies here, and more sharply — the plugin decides whether to write into a user's note based on this value.
- **Do not bump `SUPPORTED_PROTOCOL`.** It stays `1`. The field is additive.
- **Version: `0.15.0`.** A new exported symbol is a feature. `AGENTS.md` reserves minor as the floor for breaking changes on the `0.x` line; it does not make minor exclusive to them, and a patch number would understate a widened public surface.
- **Branch:** `feat/begin-mode`, cut from `main`. One PR.
- **The full gate, before every push:** `bun test && bun run typecheck && bun run build && bun run test:e2e`. `AGENTS.md`: "bun test transpiles without typechecking, so a green suite is not evidence that tsc is happy."
- **This change is not done when it is tagged.** `AGENTS.md` § "A change here is not done when it is tagged" governs. The plugin work that consumes it is the second half, and it lives in `shorthand-obsidian-plugin/docs/superpowers/plans/2026-08-29-plugin-ux-improvements.md`.

---

### Task 1: Parse and expose `begin.mode`

**Files:**
- Modify: `src/stream/client.ts` — the `WireEvent` union (line 14), a new `BEGIN_MODES` const and `BeginMode` type near `stringArrayField` (around line 52-62), and the `case "begin"` arm of `parseWireRecord` (line 112-115)
- Modify: `src/index.ts` — export the new type and const
- Test: `test/client.test.ts` — beside the existing `parseWireRecord` tests at lines 57-95

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const BEGIN_MODES = ["meeting", "assisted-notes", "dictation"] as const;`
  - `export type BeginMode = (typeof BEGIN_MODES)[number];`
  - `WireEvent`'s `begin` variant becomes `{ t: "begin"; session: number; streaming: boolean; mode?: BeginMode } & Stamp`.
  - Both are re-exported from the package root.

- [ ] **Step 1: Write the failing tests**

Add to `test/client.test.ts`, in the same `describe` as the existing `parseWireRecord` cases:

```ts
  test("reads a begin record's capture mode", () => {
    expect(parseWireRecord({ t: "begin", session: 1, streaming: true, mode: "assisted-notes" })).toEqual({
      t: "begin",
      session: 1,
      streaming: true,
      mode: "assisted-notes",
      unstamped: true,
    });
  });

  test("accepts a begin record with no mode, because every app before the field omits it", () => {
    expect(parseWireRecord({ t: "begin", session: 1, streaming: true })).toEqual({
      t: "begin",
      session: 1,
      streaming: true,
      unstamped: true,
    });
  });

  // Dropped rather than passed through: the plugin decides whether to attach a
  // capture to a user's note from this value, so it must never see one the app
  // did not really send. Same rule as `capabilities`.
  test("drops a mode it does not recognize instead of passing it through", () => {
    expect(parseWireRecord({ t: "begin", session: 1, streaming: true, mode: "karaoke" })).toEqual({
      t: "begin",
      session: 1,
      streaming: true,
      unstamped: true,
    });
    expect(parseWireRecord({ t: "begin", session: 1, streaming: true, mode: 7 })).toEqual({
      t: "begin",
      session: 1,
      streaming: true,
      unstamped: true,
    });
  });

  test("keeps rejecting a begin record with no streaming flag", () => {
    expect(parseWireRecord({ t: "begin", session: 1, mode: "meeting" })).toBeNull();
  });
```

The `unstamped: true` in each expectation comes from `stamp()`: a record with no `session_elapsed_ms` gets that marker. Check the existing `begin` expectations in this file and match whatever they do — if they pass a `session_elapsed_ms`, do the same rather than relying on `unstamped`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/client.test.ts
```

Expected: the first test FAILS — the received object has no `mode` key. The second and fourth PASS already (they assert existing behaviour and are regression cover). The third PASSES for the wrong reason today, because nothing reads the field at all; it becomes meaningful in Step 3.

- [ ] **Step 3: Write the implementation**

In `src/stream/client.ts`, add below `stringArrayField`:

```ts
/**
 * Every capture mode `shorthand-app` names on a `begin` record. The spellings are
 * the wire contract and must match its `FollowMode` serialization exactly.
 */
export const BEGIN_MODES = ["meeting", "assisted-notes", "dictation"] as const;

export type BeginMode = (typeof BEGIN_MODES)[number];

/**
 * Absent and unrecognized are the same answer — `undefined` — and deliberately so.
 *
 * Absent is the common, permanent case: every app that predates the field omits it.
 * Unrecognized is dropped for the reason `stringArrayField` gives above: a consumer
 * gates behaviour on this, and the plugin's gate decides whether to start writing
 * into someone's note. A mode invented by a newer app must read as "not one of the
 * modes I know", never as one of them.
 *
 * A follower that must distinguish "this app has no mode field" from "this session's
 * mode is unknown to me" reads the `begin-mode` capability on `hello`, which is what
 * that capability exists for.
 */
function beginModeField(value: Record<string, unknown>): BeginMode | undefined {
  const field = value.mode;
  return (BEGIN_MODES as readonly unknown[]).includes(field) ? (field as BeginMode) : undefined;
}
```

Change the `begin` variant of `WireEvent` (line 14) to:

```ts
  | ({ t: "begin"; session: number; streaming: boolean; mode?: BeginMode } & Stamp)
```

And the `case "begin"` arm of `parseWireRecord`:

```ts
    case "begin": {
      if (typeof input.streaming !== "boolean") return null;
      const mode = beginModeField(input);
      // Conditional spread, matching every other optional field in this parser:
      // `exactOptionalPropertyTypes` forbids assigning an explicit `undefined` to
      // an optional property.
      return { t: "begin", session, streaming: input.streaming, ...(mode === undefined ? {} : { mode }), ...eventStamp };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test test/client.test.ts
```

Expected: all four PASS.

- [ ] **Step 5: Export from the package root**

`src/index.ts:36-37` exports the stream client as a value line and a type line:

```ts
export { StreamClient } from "./stream/client.js";
export type { ExitDiagnosis, StreamClientOptions } from "./stream/client.js";
```

Follow that split — `BEGIN_MODES` is a value, `BeginMode` is a type:

```ts
export { BEGIN_MODES, StreamClient } from "./stream/client.js";
export type { BeginMode, ExitDiagnosis, StreamClientOptions } from "./stream/client.js";
```

`WireEvent` is deliberately not exported here and stays that way.

**`BEGIN_MODES` is exported as a value, not only as a type, and that is the point.** `StreamClient extends EventEmitter` with no typed event map (`src/stream/client.ts:206`), so a consumer's `client.on("event", ({ record }) => ...)` receives `record` as a contextual `any`. Nothing on that path type-checks `record.mode` against anything — it would compile identically if this task were never done. The plugin therefore has to re-validate the value at its own boundary, and `BEGIN_MODES` is what it validates against. Exporting only the type would leave the consumer with a cast and no check.

- [ ] **Step 6: Run the full gate**

```bash
bun test && bun run typecheck && bun run build && bun run test:e2e
```

Expected: all four PASS.

- [ ] **Step 7: Commit**

```bash
git add src/stream/client.ts src/index.ts test/client.test.ts
git commit -m "feat: parse the capture mode on begin records

A follower could not tell a meeting from a dictation burst. An
unrecognized value is dropped rather than passed through, for the same
reason capabilities are: the consumer gates note-writing on it."
```

---

### Task 2: Document the field, then release

**Files:**
- Modify: `docs/CONTRACT.md`
- Modify: `package.json` (version)

**Interfaces:**
- Consumes: `BeginMode` and `BEGIN_MODES` from Task 1.
- Produces: tag `0.15.0`, which `shorthand-obsidian-plugin` pins as the first step of its own plan.

- [ ] **Step 1: Record the new public surface**

`docs/CONTRACT.md` is this repo's description of its exported surface. Find where `WireEvent` or the stream client's exports are described and add `BEGIN_MODES` and `BeginMode` alongside them, with the `begin.mode` field noted as optional.

If `CONTRACT.md` turns out not to enumerate the stream exports at all, do not invent a section for them — say so in the PR body instead, and skip this step. Read the file before deciding.

`docs/ENHANCEMENT-LIMITS.md` is untouched: no number in `src/config.ts` changed.

- [ ] **Step 2: Bump the version**

Set `"version": "0.15.0"` in `package.json`.

- [ ] **Step 3: Run the full gate again**

```bash
bun test && bun run typecheck && bun run build && bun run test:e2e
```

Expected: all four PASS.

- [ ] **Step 4: Commit, push, open the PR**

```bash
git add docs/CONTRACT.md package.json
git commit -m "chore: 0.15.0"
git push -u origin feat/begin-mode
gh pr create --title "feat: parse the capture mode on begin records" --body "$(cat <<'EOF'
## What

`WireEvent`'s `begin` variant gains an optional `mode` — `meeting`, `assisted-notes` or `dictation` — parsed from the field `shorthand-app` now emits. New exports: `BEGIN_MODES`, `BeginMode`.

## Why

A follower could see that a recording started but not what kind, so it could not decide whether a session was its business. The Obsidian plugin needs that to attach a capture to a note when the user starts a recording with Shorthand's own hotkey, without also attaching one to a dictation burst.

An unrecognized value is dropped rather than passed through, following `stringArrayField`'s precedent in the same file: a consumer that gates behaviour on a value must never see one the app did not really send.

## Verification

- `bun test`, `bun run typecheck`, `bun run build`, `bun run test:e2e` — all clean

## Not done when this is tagged

Per AGENTS.md, the consuming half is `shorthand-obsidian-plugin`, whose plan bumps this pin as its first step.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Merge and tag**

After review:

```bash
git checkout main && git pull
git tag -a 0.15.0 -m "0.15.0 — begin records carry the capture mode"
git push origin 0.15.0
git ls-remote --tags origin '0.15.0^{}'
```

The last command is the verification `AGENTS.md` asks for: tags here are annotated, so `git ls-remote --tags origin 0.15.0` returns the tag object rather than the commit, and `0.15.0^{}` is what shows where it actually points.
