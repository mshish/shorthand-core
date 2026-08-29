# shorthand-core

`shorthand-core` is the shared engine for Shorthand meeting notes. It follows Shorthand's live transcript, keeps an optional transcript note, and updates a structured meeting summary through Claude, Codex, or an LLM provider.

Most people do not need to run core directly. Use the [Shorthand Obsidian plugin](https://github.com/mshish/shorthand-obsidian-plugin) for the Obsidian interface. Core is for developers building another note integration or running the workflow from a terminal.

## Install as a library

The package is distributed from GitHub rather than npm. Pin a tag so builds do not change underneath you:

```json
{
  "dependencies": {
    "shorthand-core": "github:mshish/shorthand-core#0.13.0"
  }
}
```

Use npm in consuming projects. This repository itself uses Bun.

Public entry points:

| Import | What it contains |
| --- | --- |
| `shorthand-core` | Capture, enhancement, and sink interfaces |
| `shorthand-core/markdown` | Markdown note and scaffold support |
| `shorthand-core/google` | Google Docs support and credential loading |
| `shorthand-core/testing` | Conformance tests for new sinks and credential writers |

See [CONTRACT.md](docs/CONTRACT.md) before adding a new output target.

## Build and test

Install [Bun](https://bun.sh/) and Node.js 22 or later, then run:

```sh
bun install
bun run typecheck
bun test
bun run build
bun run test:e2e
```

The build creates `dist/shorthand-notes.mjs`. The tests use local fixtures and do not need Shorthand, Obsidian, an AI account, or network access.

## Headless CLI

Shorthand must be running with **Follow live transcript output** enabled before capture begins.

Create a meeting note:

```sh
node dist/shorthand-notes.mjs init-note --vault "/path/to/vault" --note "Meetings/Standup.md"
```

Start capture and live enhancement:

```sh
node dist/shorthand-notes.mjs capture --vault "/path/to/vault" --note "Meetings/Standup.md" --enhance
```

Run `node dist/shorthand-notes.mjs` to see every command and option.

The default enhancement backend uses a logged-in Claude CLI. You can also select:

- `--backend codex` for a logged-in Codex CLI
- `--backend llm` for OpenAI, Anthropic, Ollama, or another OpenAI-compatible endpoint

The Claude backend can look up related notes in the vault. Codex and LLM provider backends only receive the current note and transcript.

## How notes are protected

Core changes only the section between Shorthand's ownership markers. Your own notes stay outside that section. If the markers are missing or malformed, core stops instead of guessing where it can write.

The full behavior and safety rules are documented in:

- [Design](docs/DESIGN.md)
- [Consumer contract](docs/CONTRACT.md)
- [Enhancement limits](docs/ENHANCEMENT-LIMITS.md)

## License

MIT. See [LICENSE](LICENSE).
