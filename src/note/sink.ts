import type { Section } from "./markers.js";

/**
 * The destination port for AI-owned sections.
 *
 * Deliberately transport-neutral: a Markdown file, a Notion page, or any other
 * store must be expressible here. Nothing in this module may reference the
 * filesystem, marker comments, or block hashes — those belong to the adapter.
 */

/**
 * Transport-neutral failure categories.
 *
 * - `not-found` — the target does not exist (missing file, deleted page).
 * - `forbidden` — the target exists but cannot be written (read-only, auth).
 * - `invalid-target` — the target is not in a shape this sink can own
 *   (missing/duplicated ownership boundary, unexpected document structure).
 * - `invalid-content` — the stored or supplied sections cannot be represented.
 * - `busy` — transiently unavailable (lock contention, `429`); the same call may
 *   be retried. Core must never count this toward a permanent-failure budget.
 * - `transport` — an I/O or network failure while talking to the target.
 */
export type SinkErrorCode =
  | "not-found"
  | "forbidden"
  | "invalid-target"
  | "invalid-content"
  | "busy"
  | "transport";

export type SinkError = Readonly<{
  code: SinkErrorCode;
  message: string;
  /** Backoff hint for `busy`; ignored for every other code. */
  retryAfterMs?: number;
  cause?: unknown;
}>;

/**
 * Everything a pass needs, captured together.
 *
 * `revision` is opaque to core: a content hash, an etag, or a version number
 * are all equally valid. Core only ever hands it back to `write`.
 */
export type SinkSnapshot = Readonly<{
  sections: readonly Section[];
  userNotes: string;
  revision: string;
}>;

export type SinkReadResult =
  | { ok: true; value: SinkSnapshot }
  | { ok: false; error: SinkError };

export type SinkWriteResult =
  | { status: "written"; revision: string }
  | { status: "unchanged"; revision: string }
  /**
   * The target moved since `expectedRevision` was read; re-read and retry.
   *
   * Precedence is fixed: a stale `expectedRevision` yields `stale` even when the
   * supplied sections happen to equal what is already stored. Concurrency is
   * checked before content, so `unchanged` always implies a current revision.
   */
  | { status: "stale" }
  /** Transiently unavailable (lock contention, `429`); the same write may retry. */
  | { status: "busy"; retryAfterMs?: number }
  | { status: "error"; error: SinkError };

export interface NoteSink {
  /** Everything a pass needs, read together so sections and notes share one revision. */
  read(): Promise<SinkReadResult>;
  write(sections: readonly Section[], expectedRevision: string): Promise<SinkWriteResult>;
  /** Where the agent may look for related context. Absent for API sinks. */
  readonly agentContext?: { cwd: string };
  /** Human-readable target, for status and logs. */
  readonly describe: string;
}

export function sinkError(code: SinkErrorCode, message: string, cause?: unknown): SinkError {
  return { code, message, ...(cause === undefined ? {} : { cause }) };
}

/** A transient read/write failure the caller should retry rather than count against it. */
export function busySinkError(message: string, retryAfterMs?: number, cause?: unknown): SinkError {
  return {
    code: "busy",
    message,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(cause === undefined ? {} : { cause }),
  };
}
