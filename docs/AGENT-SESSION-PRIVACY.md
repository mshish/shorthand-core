# Agent session privacy and ownership

Shorthand uses resumable Claude and Codex sessions only as memory within one live note-taking
session. The meeting note remains authoritative, the agent never owns the destination, and no
archived session is ever resumed by Shorthand.

## Data flow

```text
transcript delta + current sections + user notes
                    |
                    v
              EnhanceRunner
                    |
                    v
          AgentClient.query(schema)
                    |
                    v
       { sections: [{ heading, markdown }] }
                    |
            schema + zod validation
                    |
                    v
       NoteSink.write(sections, revision)
```

The provider returns the complete desired section array, not a file patch. Core validates that
untrusted value and the sink alone writes the AI-owned range. The session id is retained in the
runner only so later passes in the same capture can resume provider memory.

## Lifetime contract

`EnhanceRunner.dispose()` is the terminal boundary. It stops new work, aborts and awaits any
active provider query, then calls the client's optional `dispose()`. Consumers must use it for
normal capture completion, failed startup, standalone enhancement, and any awaited shutdown.
`stop()` remains a synchronous abort primitive for process/UI teardown but is not session
cleanup by itself.

Local provider history is deleted by default:

- `ClaudeAgentClient` records every session id as soon as the SDK emits it, including a turn
  that later fails or times out. Disposal calls the Agent SDK's `deleteSession()` with the same
  project directory used by the query.
- `CodexAgentClient` deletes its complete temporary runtime root. That root contains both the
  scratch working directory and the isolated `CODEX_HOME` where Codex writes thread state.

This guarantee covers local resumable transcripts. It does not claim to delete provider-side
usage, billing, safety, or telemetry records. A hard process kill can also bypass graceful
cleanup; the Codex client has a best-effort synchronous process-exit sweep, while Claude's SDK
offers only asynchronous deletion.

## Optional retention

`retainSessionHistory` is an explicit advanced opt-in. It does not add a session browser,
resume command, import path, or integration with the ordinary Claude/Codex session lists.

Claude retention leaves the SDK-managed transcript where Claude normally stored it. Codex
cannot safely use the operator's ambient `CODEX_HOME`: that would restore personal MCP servers,
skills, apps, and configuration to an agent reading untrusted meeting text. It therefore keeps
the live isolation described in `DESIGN.md`.

When Codex retention is enabled, disposal:

1. waits until the Codex query has stopped;
2. unlinks `auth.json`, whether it was a hard link or a cross-volume copy;
3. deletes the scratch working directory;
4. moves the remaining isolated home into
   `shorthandConfigDirectory()/agent-sessions/codex/session-<random UUID>`; and
5. uses a recursive copy-then-remove fallback when OS temp and the config directory are on
   different volumes.

The archive is deliberately opaque and credential-free. Shorthand never points Codex back at
it, so preserving the complete home avoids depending on Codex's undocumented internal session
file layout without turning that layout into a public contract.

## Cross-platform boundary

The supported host set is Obsidian desktop on Windows, macOS, and Linux. Paths use Node's OS
temp directory plus Shorthand's existing platform config root: `%APPDATA%\\Shorthand`,
`~/Library/Application Support/Shorthand`, or `$XDG_CONFIG_HOME/shorthand` (falling back to
`~/.config/shorthand`). Hard links are an optimization, not an assumption; copying is the
fallback. Windows file locking is why graceful disposal must wait for the child query before
deleting or moving its home.

Obsidian mobile is outside this boundary because it cannot spawn the required local Claude or
Codex executable.
