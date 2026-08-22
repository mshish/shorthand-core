# Enhancement gates, timeouts, and limits

Every number that decides whether an enhancement pass runs, how long it may take, and what
happens to the transcript when it doesn't land. One table so the whole budget can be read at
once, because the values are split across three places and no single file shows the effective
set.

**Keep this in sync.** If you change a default in `src/config.ts`, a fallback in the
`EnhanceRunner` constructor, or a value `createEnhanceRunner` passes in `bin/shorthand-notes.ts`,
update the matching row here in the same commit. A stale table is worse than no table: these
numbers are the ones an agent reasons about without re-reading the code.

## Why the values differ by column

`EnhanceRunner`'s constructor fallbacks are library defaults for a caller that passes nothing.
The CLI overrides some of them from `DEFAULT_CONFIG` and leaves the rest alone, so the numbers
that actually run during a capture are a mix of the two. **Read the capture column, not the
constructor, when reasoning about live behaviour.**

Character counts are converted to speaking time at ~195 chars/minute, measured from a real run
(see the comment on `DEFAULT_CONFIG.thresholds`): ~40s of ordinary speech produced ~130
committed characters.

## Gates — all must pass before a pass starts

Checked in order by `EnhanceRunner.tick()`. Any failure returns an outcome without calling the
agent.

| Gate | Library default | `capture --enhance` | In speech | Prevents |
| --- | --- | --- | --- | --- |
| `#inFlight` | 1 concurrent pass | same | — | Two overlapping queries. Correctness, not tuning — a second pass would re-send a transcript the first already took |
| `#disabledForReadFailures` | after 3 failures | same | — | Repeated calls against a note that cannot be read. Never resets for the rest of the session |
| `maxDurationMs` | 4h | 4h, `HANDY_NOTES_MAX_DURATION_MS` | — | A capture left running overnight still calling the model |
| `minNewChars` | 600 | **180** | ~55s | A pass with nothing new to say |
| `minIntervalMs` | 60_000 | **25_000** | — | Passes firing back-to-back. This is the real rate bound — even a failing pass respects it |

`enhanceNow()` skips the two threshold gates and honours the first three. That is what the
capture-stop pass and the standalone `enhance` command use.

## Bounds while a pass runs

| Bound | Library default | `capture --enhance` | `enhance` (standalone) | Covers |
| --- | --- | --- | --- | --- |
| `timeoutMs` | `DEFAULT_CONFIG.enhancement.timeoutMs` | 120_000 | 300_000 | The agent query only — see the gap below |
| `maxTurns` | 75 | same | same | Agent tool-loop runaway. Deliberately far above legitimate vault exploration, because hitting it ends the query with no structured output and the pass loses its work entirely |
| `maxAttempts` | 2 | same | same | One corrective retry, inside the same `timeoutMs` |

`HANDY_NOTES_AGENT_TIMEOUT_MS` overrides `timeoutMs` for both commands.

**`timeoutMs` does not cover the whole pass.** It wraps `queryForSections` only. `sink.read()`
runs before it and `sink.write()` after, and neither has a timeout of its own — `docs-client.ts`
sets none either. A hung Docs API call therefore holds the in-flight slot indefinitely, which
is the only path by which a pass outlives its stated bound.

## What happens to the transcript when a pass doesn't land

Every one of these re-queues the delta and lets the next tick retry it. The transcript is never
lost on a single failure.

| `PassOutcome` | Cause | Reported via `onStatus` | Counts toward |
| --- | --- | --- | --- |
| `completed` | — | `finished` | — |
| `not-ready` | `minNewChars` or `minIntervalMs` | not emitted | — |
| `in-flight` | a pass is already running | not emitted | — |
| `timed-out` | pass exceeded `timeoutMs`; query aborted | `requeued` | `maxRequeuesPerDelta` |
| `requeued` (`stale`) | the AI block changed while the pass ran | `requeued` | `maxRequeuesPerDelta` |
| `requeued` (`busy`) | note locked, or a `429`; carries `retryAfterMs` | `requeued` | `maxRequeuesPerDelta` |
| `skipped` | invalid output, or the agent errored | `skipped` | `maxRequeuesPerDelta` |
| `failed` | read or write error | `error` | `maxRequeuesPerDelta`, and read errors toward `maxConsecutiveReadFailures` |
| `expired` | past `maxDurationMs` | `expired`, once | — |

A `busy` read resets `maxConsecutiveReadFailures` rather than advancing it: a target that is
merely contended will come back, and marching it into a kill switch that never resets would
disable enhancement for the rest of the session.

## Retry and drop limits

| Limit | Library default | `capture --enhance` | In speech | Behaviour at the limit |
| --- | --- | --- | --- | --- |
| `maxRequeuesPerDelta` | 3 | 3 (not overridden) | — | **The delta is dropped.** Only a `logger.error` line records it — no `onStatus`, so nothing surfaces in any UI |
| `maxRequeuedCharacters` | 20_000 | 20_000 (not overridden) | ~1h 45m | Oldest text trimmed, `[...earlier transcript dropped...]` inserted at the front |
| `maxConsecutiveReadFailures` | 3 | 3 (not overridden) | — | Enhancement disabled for the rest of the session; capture continues |
| final-pass retry ladder | `[200, 500]` ms | same | — | `runFinalEnhancementWithRetries` reissues the closing `link` pass up to twice more after a timeout or requeue, preferring the target's own `retryAfterMs` |

`#pendingTranscript` — text arriving while a pass is in flight — has **no cap**. In practice
`timeoutMs` bounds it: 120s of speech is ~390 characters, against a 20_000 limit on the
re-queued half. The sink gap above is the only way it grows further.

## Adjacent timeouts that are not part of this budget

Listed so they are not confused with the enhancement path. All in `DEFAULT_CONFIG`.

| Value | Default | Governs |
| --- | --- | --- |
| `reconnect.maxAttempts` / `backoffMs` | 4, `[250, 500, 1000, 2000]` | Reconnecting to the Shorthand stream |
| `drainTimeoutMs` | 10_000 | Waiting for the follow-stream child on a graceful stop |
| `shutdownTimeoutMs` | 12_000 | Whole-process shutdown before force-stopping the child |
| `sidecarFlushIntervalMs` | 250 | Transcript sidecar write batching |

## Known sharp edges

Recorded here rather than fixed, so a future change is a decision and not a surprise.

- **A drop at `maxRequeuesPerDelta` is invisible.** A model that reliably exceeds `timeoutMs`
  loses transcript in blocks of three passes with no user-visible signal. Routing that through
  `#fail` instead of the bare logger call would emit an `error` status the CLI already prints.
- **No per-tick telemetry.** `onStatus` reports what happened but not why a tick declined —
  `not-ready` and `in-flight` are not emitted at all, so the common case of "nothing is
  happening" produces no record of which gate held.
