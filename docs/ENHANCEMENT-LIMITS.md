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

The state machine rejects requests from `running`, `expired`, or
`disabledForReadFailures` directly from those states. In `idle`, `minNewChars` and
`minIntervalMs` are the only guards. Any decline resolves without calling the agent.

| Gate | Library default | `capture --enhance` | In speech | Prevents |
| --- | --- | --- | --- | --- |
| `running` state | 1 concurrent pass | same | — | Two overlapping queries. Correctness, not tuning — a second pass would re-send a transcript the first already took |
| `disabledForReadFailures` state | after 3 failures | same | — | Repeated calls against a note that cannot be read. Never resets for the rest of the session |
| `maxDurationMs` | 4h | 4h, `HANDY_NOTES_MAX_DURATION_MS` | — | A capture left running overnight still calling the model |
| `minNewChars` | 600 | **180** | ~55s | A pass with nothing new to say |
| `minIntervalMs` | 60_000 | **25_000** | — | Passes firing back-to-back. This is the real rate bound — even a failing pass respects it |

`enhanceNow()` skips the two threshold gates and honours the first three. That is what the
capture-stop pass and the standalone `enhance` command use.

## Bounds while a pass runs

| Bound | Library default | `capture --enhance` | `enhance` (standalone) | Covers |
| --- | --- | --- | --- | --- |
| `timeoutMs` | `DEFAULT_CONFIG.enhancement.timeoutMs` | 240_000 | 600_000 | The whole pass: sink read, both model attempts, and sink write |
| `maxTurns` | 75 | same | same | Agent tool-loop runaway. Deliberately far above legitimate vault exploration, because hitting it ends the query with no structured output and the pass loses its work entirely |
| `maxAttempts` | 2 | same | same | One corrective retry, inside the same `timeoutMs` |

`HANDY_NOTES_AGENT_TIMEOUT_MS` overrides `timeoutMs` for both commands.

`running` owns an XState `after: timeoutMs` transition. Leaving `running` cancels the invoked
promise actor and passes its `AbortSignal` through `queryForSections`, so an active model query
is genuinely aborted. The bound starts before `sink.read()` and remains active through
`sink.write()`; a hung document call therefore releases the in-flight state at the deadline.
The sink interface does not accept an abort signal, so a `read()` or `write()` already in
progress can still settle later in the background. Its result is discarded and it no longer
blocks another pass. The runner checks the signal after `read()` and after the model query, so
a timed-out pass never *starts* a write; a write that began before the deadline may still commit.

## What happens to the transcript when a pass doesn't land

Failures retain the delta until `maxRequeuesPerDelta` is exceeded. One conclusion boundary
decides retention first, then mutates context, emits one terminal status, and constructs the
outcome, so a dropped delta cannot be reported as re-queued.

| `PassOutcome` | Cause | Reported via `onStatus` | Counts toward |
| --- | --- | --- | --- |
| `completed` | — | `finished` | — |
| `not-ready` | `minNewChars` or `minIntervalMs` | `declined` with reason `characters` or `interval`, episode-deduplicated | — |
| `in-flight` | a pass is already running | `declined` with reason `in-flight`, episode-deduplicated | — |
| `timed-out` | whole pass exceeded `timeoutMs`; invoked query aborted | `timed-out` | `maxRequeuesPerDelta` |
| `requeued` (`stale`) | the AI block changed while the pass ran | `requeued` | `maxRequeuesPerDelta` |
| `requeued` (`busy`) | note locked, or a `429`; carries `retryAfterMs` | `requeued` | `maxRequeuesPerDelta` |
| `skipped` | invalid output, or the agent errored | `skipped` | `maxRequeuesPerDelta` |
| `failed` | read or write error, or the delta was dropped | `error`, or `disabled-for-read-failures` at the kill switch | `maxRequeuesPerDelta`, and read errors toward `maxConsecutiveReadFailures` |
| `expired` | past `maxDurationMs` | `expired`, once | — |

A `busy` read resets `maxConsecutiveReadFailures` rather than advancing it: a target that is
merely contended will come back, and marching it into a kill switch that never resets would
disable enhancement for the rest of the session.

`EnhanceStatus` is discriminated on `kind`. Only pass-terminal variants carry `durationMs`,
measured around `queryForSections` so it is model latency rather than sink latency. Only tiered
variants carry `tier`, and only `requeued` can carry `retryAfterMs`. `onStatus` is the public
observability channel; machine inspection is a private safe projection enabled only by the
explicit `traceMachine` option and sent to `logger.info`. It never includes snapshots,
transcript text, or session ids. Supplying a logger alone reports error statuses without
turning on per-microstep tracing.

## Retry and drop limits

| Limit | Library default | `capture --enhance` | In speech | Behaviour at the limit |
| --- | --- | --- | --- | --- |
| `maxRequeuesPerDelta` | 3 | 3 (not overridden) | — | **The delta is dropped.** The outcome is `failed` and exactly one terminal `error` status reports the drop (or the disabling status when the same read failure trips the kill switch) |
| `maxRequeuedCharacters` | 20_000 | 20_000 (not overridden) | ~1h 45m | Oldest text trimmed, `[...earlier transcript dropped...]` inserted at the front |
| `maxConsecutiveReadFailures` | 3 | 3 (not overridden) | — | Enhancement disabled for the rest of the session; capture continues |
| final-pass retry ladder | `[200, 500]` ms | same | — | `runFinalEnhancementWithRetries` reissues the closing `link` pass up to twice more after a timeout or requeue, preferring the target's own `retryAfterMs` |

Pending transcript — text arriving while a pass is in flight — has **no cap**. In practice
the whole-pass `timeoutMs` bounds it: 240s of speech is ~780 characters, against a 20_000
limit on the re-queued half.

## Adjacent timeouts that are not part of this budget

Listed so they are not confused with the enhancement path. All in `DEFAULT_CONFIG`.

| Value | Default | Governs |
| --- | --- | --- |
| `reconnect.maxAttempts` / `backoffMs` | 4, `[250, 500, 1000, 2000]` | Reconnecting to the Shorthand stream |
| `drainTimeoutMs` | 10_000 | Waiting for the follow-stream child on a graceful stop |
| `shutdownTimeoutMs` | 12_000 | Whole-process shutdown before force-stopping the child |
| `sidecarFlushIntervalMs` | 250 | Transcript sidecar write batching |

## Known sharp edges

Recorded here so a future change is a decision and not a surprise.

- **Sink cancellation remains cooperative outside the runner contract.** The state-machine
  deadline releases the pass slot and discards a late sink result, but `NoteSink.read()` and
  `write()` do not accept an `AbortSignal`. A provider with no cancellation of its own may keep
  an already-started operation alive in the background. Signal checks prevent a late read or
  model result from initiating a write; a write started before the deadline may still commit.
- **XState timers are referenced.** Unlike the deleted hand-rolled tick timer, which called
  `unref()`, XState's default clock keeps Node alive. `idle.waiting` owns the interval and
  duration `after` timers; `running` owns the whole-pass timeout and a duration timer. Calling
  `stopLiveTicks()` permanently latches automatic ticks off and leaves `idle.waiting`, but it
  deliberately does not interrupt an active pass. Embedders must call `stop()` when finished:
  it stops the actor, cancels every state-owned timer, aborts an invoked pass, resolves an
  outstanding pass as `failed`, and resolves all `waitForIdle()` callers. Both CLI commands do
  this in `finally`, including when earlier teardown fails.
- **A timed-out first Claude pass does not bootstrap the resumable session.** Its server-side
  session id arrives, if at all, after the conclusion boundary has committed. The next pass
  starts a fresh session rather than adopting late state outside that single boundary.
