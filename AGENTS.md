# AGENTS.md

Guidance for AI coding assistants working in this repository.

## What this is

`shorthand-core` is the shared library behind Shorthand's meeting-note capture:
the transcript stream client, the note sinks and marker contract, and the
enhancement agent that turns a transcript into note sections.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture,
[docs/CONTRACT.md](docs/CONTRACT.md) for the public surface, and
[docs/ENHANCEMENT-LIMITS.md](docs/ENHANCEMENT-LIMITS.md) for every gate, timeout
and retry limit on the enhancement path.

**The limits table is maintained by hand.** The effective budget is split across
`DEFAULT_CONFIG`, the `EnhanceRunner` constructor fallbacks, and what
`createEnhanceRunner` passes in `bin/shorthand-notes.ts` — no file shows the set
that actually runs. If you change a number in any of the three, update the
matching row in the same commit. Nothing enforces this, so a stale row will
mislead the next agent rather than fail a test.

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

To exercise the workflow itself rather than the scripts it calls, run CI locally
with [`act`](https://github.com/nektos/act) instead of pushing to find out:

```bash
act push -W .github/workflows/ci.yml
```

`ci.yml` is a single `ubuntu-latest` job, so act reproduces it in full. **On
Windows run act from inside WSL**, not from PowerShell or Git Bash — NTFS has no
executable bit to copy into the container, so composite actions fail with
`Permission denied` on their own scripts and it reads as a broken workflow.

## This repository is public, and you can push your work

The repository is public. Commit, push, and tag your own work without stopping
to ask. Contributions from outside go through a pull request.

Still confirm before force-pushing, rewriting published history, or deleting a
tag another checkout may already have fetched.

## Releasing, and why the timing matters

`shorthand-obsidian-plugin` consumes this package as
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

## A change here is not done when it is tagged

The tag is the middle of the work. `shorthand-obsidian-plugin` pins this package by
tag, so every breaking change lands in two halves: the retype here, and the
consumer that has to survive it. Stopping at the tag leaves a repo that builds
from a clean checkout and a consumer that does not — and nothing in either
repo's CI will tell you, because they are tested independently.

**Take the whole change, across both repos, as one unit of work.** After
pushing and tagging here: bump the plugin's pin, fix what the new types break,
and run the plugin's own gates. Only then is the change finished. If you truly
cannot reach the other repo, say so plainly and name exactly what is left
undone — do not report the work as complete.

This is not hypothetical caution. The plugin's `onEnhanceStatus` once had a
missing case that made enhancement passes fail silently, forever, with every
check green. Adding a member to `EnhanceStatus["kind"]` reproduces that exact
failure by construction: an exhaustive switch that no longer is one, in a repo
whose tests never imported the new type. Widening an exported union here is
therefore a change to the plugin, whether or not anyone opens that repo.

The same holds inside this repo. A number changed in `src/config.ts` is not
done until `docs/ENHANCEMENT-LIMITS.md` agrees with it, and a behaviour changed
in `EnhanceRunner` is not done until the comment naming the failure it prevents
still tells the truth.

## The enhancement prompt is split, deliberately

`src/agent/contract.ts` exports two halves:

- `ENHANCEMENT_SAFETY_PREAMBLE` — the injection guard, the marker-token ban,
  "you do not write files", and "the given sections are authoritative". Always
  prepended by `EnhanceRunner`, never caller-supplied.
- `DEFAULT_EDITORIAL_GUIDANCE` — the note-writing voice. Callers replace it via
  `EnhanceRunnerOptions.guidance`.

Output *shape* is not defended by prose. Both backends enforce it at the
provider boundary, with the schema derived from the zod schema by
`buildSectionOutputSchema()`: the Claude Agent SDK backend passes
`outputFormat: { type: "json_schema" }`; the LLM backend passes
`responseFormat: { type: "json", schema }`, which the AI SDK's `Output.object()`
builds and `generateText` forwards to the provider. The result is re-validated
after the fact by `validateSectionOutput()` for everything a JSON Schema cannot
express (marker tokens, the total-character cap, one-line headings, image and
raw-HTML neutralization, the `renderSections` writer check). Enforcement is only
as good as the endpoint: a weak local model, or an OpenAI-compatible endpoint
that ignores `response_format`, degrades to best-effort.

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
