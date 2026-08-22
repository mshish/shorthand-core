Read @AGENTS.md

The rest is deliberately not imported — open it only when the work calls for it.

- `docs/ENHANCEMENT-LIMITS.md` — before changing any gate, timeout, retry or
  drop limit. It is maintained by hand and `AGENTS.md` requires it to be updated
  in the same commit as the number.
- `docs/CONTRACT.md` — before changing `NoteSink`, revision semantics, or
  anything a second implementation must satisfy. The conformance suites in
  `src/testing/` are shipped API, not tests.
- `docs/DESIGN.md` — before deleting something that looks like over-caution. It
  records failures that already happened and says which fixes are easy to undo
  by accident.
- `README.md` — commands, and what each entry point deliberately does and does
  not export.

Changing an exported symbol makes the Obsidian plugin at
`D:/tools/obsidian-shorthand` part of this task, not a follow-up. See
`AGENTS.md` § "A change here is not done when it is tagged".
