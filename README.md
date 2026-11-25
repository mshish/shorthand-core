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
| `shorthand-core/testing` | Conformance tests for new sinks and the Google credentials writer |

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

Start the Shorthand desktop app before capture begins. **Follow live transcript output** is enabled by default for Meetings and Assisted notes.

Create a meeting note:

```sh
node dist/shorthand-notes.mjs init-note --vault "/path/to/vault" --note "Meetings/Standup.md"
```

Start capture and live enhancement:

```sh
node dist/shorthand-notes.mjs capture --vault "/path/to/vault" --note "Meetings/Standup.md" --enhance
```

Capture keeps following the app across recordings until you stop it. Add `--exit-after-session` to end after one recording instead; that is how the Shorthand app runs capture when it fills a Google Doc for a meeting.

With `--sink google`, each meeting gets a new tab in the doc named in `google-credentials.json`. Pass `--google-document <id>` to write into the first tab of that document instead; the Shorthand app does this when it makes a doc for each meeting.

Add `--google-transcript` to capture to keep a copy of the transcript in the same doc: a **Transcript** tab nested under the meeting's tab, or a top-level **Transcript** tab with `--google-document`. The sidecar file is still written; the tab is rewritten from it every 10 seconds and once more when capture ends.

Add `--assisted-notes` to capture when the recording is Shorthand's **Assisted notes** mode (one person thinking out loud rather than a meeting). The agent then follows the assisted-notes guidance instead of the meeting guidance.

Run `node dist/shorthand-notes.mjs` to see every command and option.

The default enhancement backend uses a logged-in Claude CLI. You can also select:

- `--backend codex` for a logged-in Codex CLI
- `--backend llm` for OpenAI, Anthropic, Ollama, or another OpenAI-compatible endpoint
- `--backend cursor` for a logged-in Cursor command line tool (`--cursor-exe`, `--cursor-model`)
- `--backend acp` for any other program that speaks the Agent Client Protocol over standard I/O (`--acp-exe`, required; `--acp-args`, split on spaces; `--acp-model`)

The Claude backend can look up related notes in the vault. The other backends only receive the current note and transcript.

### `--backend llm`

This backend needs Shorthand 0.5.0 or newer running. Core never holds the provider key: Shorthand keeps it in the operating system keyring and makes the request on core's behalf, so no key is passed on the command line, set in the environment, or stored in a file core reads. Add the key in Shorthand's settings before capture.

Name the provider and model on the command line:

```sh
node dist/shorthand-notes.mjs capture --vault "/path/to/vault" --note "Meetings/Standup.md" --enhance \
  --backend llm --llm-provider openai --llm-model gpt-5
```

| Flag | Environment fallback | Notes |
| --- | --- | --- |
| `--llm-provider` | `HANDY_NOTES_LLM_PROVIDER` | `openai`, `anthropic`, `ollama`, or `openai-compatible` |
| `--llm-model` | `HANDY_NOTES_LLM_MODEL` | Required |
| `--llm-base-url` | `HANDY_NOTES_LLM_BASE_URL` | Optional override for a gateway or proxy. Required for `openai-compatible`, which names no endpoint of its own. `http` or `https` only |

If Shorthand is not running, capture stops with `Shorthand is not running. Open the Shorthand app, then retry.` rather than falling back to an unauthenticated call.

## How notes are protected

Core changes only the section between Shorthand's ownership markers. Your own notes stay outside that section. If the markers are missing or malformed, core stops instead of guessing where it can write.

The full behavior and safety rules are documented in:

- [Design](docs/DESIGN.md)
- [Consumer contract](docs/CONTRACT.md)
- [Enhancement limits](docs/ENHANCEMENT-LIMITS.md)

## License

MIT. See [LICENSE](LICENSE).
