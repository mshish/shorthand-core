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

## Reading the model catalog

`listClaudeModels()` and `listCodexModels()` exist so a consumer can offer the models and
per-model efforts a backend actually accepts, instead of a hand-maintained list that goes stale
and offers combinations the provider rejects.

**The Codex catalog probe is the one Codex spawn that deliberately uses the operator's ambient
`CODEX_HOME`.** It has to: the catalog is account-scoped. A signed-in home returns six models
including the `gpt-5.4` family; an isolated home has no credentials and returns five, with
`gpt-5.2` substituted. Probing the isolated home would therefore answer a different question
than the one asked and present the user a list that is not theirs.

This does not weaken the isolation described in `DESIGN.md`, because the isolation defends
against a specific thing that is absent here: an agent *reading untrusted meeting text* with
the operator's MCP servers, skills, and apps restored around it. The catalog probe starts no
thread and sends no prompt. No transcript, section, user note, or vault path reaches it. It
issues `model/list` and `account/read` and kills the child. The Claude probe is the same shape —
it constructs a query solely to read the cached `initialize` response and never iterates the
stream, so no turn runs and no tokens are spent.

The one personal value either probe returns is the signed-in account's email, which exists so a
consumer can show *which* login is in use rather than asserting that some login is.

**Neither backend fails when signed out.** Both return a shorter catalog and no error. Sign-in
is therefore reported separately, as `AgentCatalog.signedIn`, and must never be inferred from a
thrown error — a consumer that conflated the two would silently present a signed-out user a
degraded catalog as if it were their own.

## Cross-platform boundary

The supported host set is Obsidian desktop on Windows, macOS, and Linux. Paths use Node's OS
temp directory plus Shorthand's existing platform config root: `%APPDATA%\\Shorthand`,
`~/Library/Application Support/Shorthand`, or `$XDG_CONFIG_HOME/shorthand` (falling back to
`~/.config/shorthand`). Hard links are an optimization, not an assumption; copying is the
fallback. Windows file locking is why graceful disposal must wait for the child query before
deleting or moving its home.

Obsidian mobile is outside this boundary because it cannot spawn the required local Claude or
Codex executable.
