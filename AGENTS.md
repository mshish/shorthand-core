# AGENTS.md

Guidance for AI coding assistants working in this repository.

## What this is

`shorthand-core` is the shared library behind Shorthand's meeting-note capture:
the transcript stream client, the note sinks and marker contract, and the
enhancement agent that turns a transcript into note sections.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture and
[docs/CONTRACT.md](docs/CONTRACT.md) for the public surface.

## Commands

```bash
bun install
bun test              # bun:test
bun run typecheck     # tsc --noEmit
bun run build         # esbuild bundle -> dist/shorthand-notes.mjs
bun run test:e2e      # node test/e2e-smoke.mjs, exercises the CLI end to end
```

All four are the gate. Run them before every push — `bun test` transpiles
without typechecking, so a green suite is not evidence that `tsc` is happy.

## This repo is private, and pushing needs no permission

It is a single-user private repo. Commit, push and tag as part of finishing the
work; do not stop to ask. A bad tag can be moved.

Still confirm before force-pushing, rewriting published history, or deleting a
tag another checkout may already have fetched.

## Releasing, and why the timing matters

`obsidian-shorthand` consumes this package as
`"shorthand-core": "github:mshish/shorthand-core#<tag>"` — a pinned GitHub tag,
not a path dependency or workspace link. **A local change here is invisible to
the plugin until it is pushed and tagged.**

So a cross-repo feature is ordered: land the change here → push → tag → bump the
plugin's pin as the *first* step of the plugin work, so everything after it
compiles against the real dependency. Resist local-override schemes (junctions,
`overrides`, `file:` deps); publishing is free here, and a real tag keeps the
plugin's `main` buildable from a clean checkout at every commit.

Tags are annotated, named bare with no `v` prefix:

```bash
git tag -a 0.7.0 -m "0.7.0 — <summary>"
git push origin 0.7.0
```

Because they are annotated, `git ls-remote --tags origin 0.7.0` returns the tag
object, not the commit. Compare `0.7.0^{}` when verifying a tag points where you
think.

Version on the `0.x` line: minor is the breaking slot. Removing or retyping an
exported symbol is a minor bump, not a patch.

## The enhancement prompt is split, deliberately

`src/agent/contract.ts` exports two halves:

- `ENHANCEMENT_SAFETY_PREAMBLE` — the injection guard, the marker-token ban,
  "you do not write files", and "the given sections are authoritative". Always
  prepended by `EnhanceRunner`, never caller-supplied.
- `DEFAULT_EDITORIAL_GUIDANCE` — the note-writing voice. Callers replace it via
  `EnhanceRunnerOptions.guidance`.

Output *shape* is not defended by prose. It is enforced by the Agent SDK's
`outputFormat: { type: "json_schema" }`, with the schema derived from the zod
schema by `buildSectionOutputSchema()`, and re-validated after the fact by
`validateSectionOutput()` for everything a JSON Schema cannot express (marker
tokens, the total-character cap, one-line headings, image and raw-HTML
neutralization, the `renderSections` writer check).

That split is the whole reason a user-supplied prompt is safe. If you touch the
composition in `EnhanceRunner`, the `test.each` cases in
`test/enhance-runner.test.ts` are what prove the preamble cannot be dropped —
they are load-bearing, not decoration. Verify a change to them by mutation:
break the composition on purpose and confirm the right cases fail.

## Code style

- `#private` class fields, `readonly` and `Readonly<{...}>` types
- Named exports only; `.js` extensions on relative imports
- `src/index.ts` and `src/markdown.ts` are explicit export lists. `export *` is
  banned — read the header comment in `index.ts` for why. Anything a consumer
  needs must be added to the right entry point deliberately.
- Handle errors explicitly; avoid `unwrap`-style assumptions on external input
- Comments explain *why* something exists and name the failure it prevents.
  Never restate the code. Record the actual reason, not a proxy for it — a
  reason that ages correctly survives the constraint that prompted it.

## Commits

Conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`).
The message explains *why*, not what. Breaking changes get a `!` and a
`BREAKING CHANGE:` footer naming every removed or retyped export.
