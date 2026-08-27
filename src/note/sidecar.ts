import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sessionKey, type SessionSnapshot, type TranscriptUpdate } from "../stream/transcript.js";

export const SIDECAR_SENTINEL = "# Shorthand Transcript";
const HEADER = `${SIDECAR_SENTINEL}

> [!info] Commit timing
> Timestamps below are **COMMIT time**—when text became committed—not speech time.
`;
const MAX_GAP_WARNINGS = 20;

type SidecarFileSystem = {
  mkdir: typeof mkdir;
  open: typeof open;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
};

/**
 * Transactional storage for a transcript sidecar.
 *
 * `transform` is synchronous because a store may call it again after losing an
 * optimistic-concurrency race. It must therefore be pure: the only result that
 * escapes is the value paired with the content the store actually commits.
 */
export interface SidecarStore {
  readonly describe: string;
  process<T>(
    transform: (current: string | undefined) => Readonly<{ content: string; value: T }>,
  ): Promise<T>;
}

export type SidecarWriterOptions = Readonly<{
  flushIntervalMs?: number;
  now?: () => Date;
  store?: SidecarStore;
  fileSystem?: Partial<SidecarFileSystem>;
}>;

type TimelineEntry =
  | { type: "session"; key: string }
  | { type: "gap"; id: number; text: string };

const DEFAULT_FILE_SYSTEM: SidecarFileSystem = { mkdir, open, readFile, rename, unlink };

class FileSystemSidecarStore implements SidecarStore {
  readonly #fs: SidecarFileSystem;
  #temporaryId = 0;

  constructor(readonly describe: string, fileSystem: Partial<SidecarFileSystem> = {}) {
    this.#fs = { ...DEFAULT_FILE_SYSTEM, ...fileSystem };
  }

  async process<T>(
    transform: (current: string | undefined) => Readonly<{ content: string; value: T }>,
  ): Promise<T> {
    await this.#fs.mkdir(dirname(this.describe), { recursive: true });
    const current = await this.#readCurrent();
    // This filesystem adapter is deliberately only the headless Markdown
    // transport. It preserves the existing temp-write/rename behavior but
    // cannot turn ordinary filesystem primitives into cross-process CAS.
    const candidate = transform(current);
    if (candidate.content === current) return candidate.value;

    const temporaryPath = join(
      dirname(this.describe),
      `.${basename(this.describe)}.${process.pid}.${this.#temporaryId++}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await this.#fs.open(temporaryPath, "wx");
      await handle.writeFile(candidate.content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#fs.rename(temporaryPath, this.describe);
      return candidate.value;
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.#fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async #readCurrent(): Promise<string | undefined> {
    try {
      return await this.#fs.readFile(this.describe, "utf8");
    } catch (error) {
      if (errno(error) === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class SidecarWriter extends EventEmitter {
  readonly #sessions = new Map<string, SessionSnapshot>();
  #timeline: TimelineEntry[] = [];
  readonly #flushIntervalMs: number;
  readonly #resumeTimestamp: string;
  readonly #store: SidecarStore;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #persisted = "";
  #base = HEADER.trimEnd();
  #writeChain: Promise<void> = Promise.resolve();
  #targetEstablished = false;
  #gapId = 0;

  constructor(path: string, options: SidecarWriterOptions = {}) {
    super();
    if (options.store !== undefined && options.fileSystem !== undefined) {
      throw new Error("SidecarWriter options.store and options.fileSystem are mutually exclusive.");
    }
    this.#flushIntervalMs = options.flushIntervalMs ?? 250;
    this.#resumeTimestamp = (options.now ?? (() => new Date()))().toISOString();
    this.#store = options.store ?? new FileSystemSidecarStore(path, options.fileSystem);
  }

  get path(): string {
    return this.#store.describe;
  }

  apply(update: TranscriptUpdate): void {
    const key = sessionKey(update.snapshot.connectionGeneration, update.snapshot.session);
    if (!this.#sessions.has(key)) this.#timeline.push({ type: "session", key });
    this.#sessions.set(key, update.snapshot);
    this.#schedule();
  }

  addReconnectWarning(connectionGeneration: number): void {
    const gap: TimelineEntry = {
      type: "gap",
      id: this.#gapId++,
      text: `> [!warning] Transcript gap\n> Reconnected as connection generation ${connectionGeneration}. Shorthand does not replay missed events.`,
    };
    this.#timeline.push(gap);
    const gaps = this.#timeline.filter((entry): entry is Extract<TimelineEntry, { type: "gap" }> => entry.type === "gap");
    if (gaps.length > MAX_GAP_WARNINGS) {
      const oldestId = gaps[0]?.id;
      this.#timeline = this.#timeline.filter((entry) => entry.type !== "gap" || entry.id !== oldestId);
    }
    this.#schedule();
  }

  async flush(): Promise<void> {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const attempt = this.#writeChain.then(
      () => this.#flushOnce(),
      () => this.#flushOnce(),
    );
    this.#writeChain = attempt.catch(() => {});
    try {
      await attempt;
    } catch (error) {
      const writeError = error instanceof Error ? error : new Error(String(error));
      this.emit("writeError", { error: writeError, path: this.path });
      throw writeError;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.#writeChain;
  }

  render(): string {
    return this.#renderWithBase(this.#base);
  }

  #renderWithBase(base: string): string {
    const sections = this.#timeline.flatMap((entry) => {
      if (entry.type === "gap") return [entry.text];
      const snapshot = this.#sessions.get(entry.key);
      return snapshot === undefined ? [] : [renderSession(snapshot)];
    });
    return [base, ...sections].join("\n\n");
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch(() => {});
    }, this.#flushIntervalMs);
  }

  async #flushOnce(): Promise<void> {
    const committed = await this.#store.process((current) => {
      const state = this.#candidateState(current);
      const content = this.#renderWithBase(state.base);
      return {
        content,
        value: { ...state, persisted: content },
      };
    });
    // A store may retry the callback. Mutating writer state inside it would make
    // the second invocation observe a commit that never happened.
    this.#base = committed.base;
    this.#persisted = committed.persisted;
    this.#targetEstablished = committed.targetEstablished;
  }

  #candidateState(current: string | undefined): Readonly<{ base: string; targetEstablished: boolean }> {
    if (this.#targetEstablished) {
      if (current === undefined) throw new Error(`Sidecar disappeared during capture: ${this.path}`);
      if (current !== this.#persisted) {
        throw new Error(`Sidecar changed outside Shorthand during capture: ${this.path}`);
      }
      return { base: this.#base, targetEstablished: true };
    }
    if (current === undefined) return { base: this.#base, targetEstablished: true };

    const existing = current;
    const firstLine = existing.split(/\r?\n/, 1)[0];
    if (firstLine !== SIDECAR_SENTINEL) {
      throw new Error(`Refusing to overwrite ${this.path}: first line must be "${SIDECAR_SENTINEL}".`);
    }
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return {
      base: `${existing}${separator}## Resumed ${this.#resumeTimestamp}`,
      targetEstablished: true,
    };
  }
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function renderSession(snapshot: SessionSnapshot): string {
  const lines = [`## Connection ${snapshot.connectionGeneration} · Session ${snapshot.session}`];
  if (snapshot.final !== undefined) {
    const stamp = formatCommit(snapshot.final.commitMs, snapshot.final.unstamped);
    if (snapshot.final.speaker === undefined) {
      lines.push(`**[COMMIT ${stamp}] final:**`, "", snapshot.final.text);
    } else {
      lines.push(`**[COMMIT ${stamp}] ${snapshot.final.speaker}:** ${snapshot.final.text}`);
    }
  } else {
    for (const commit of snapshot.commits) {
      lines.push(`**[COMMIT ${formatCommit(commit.commitMs, commit.unstamped)}] ${commit.speaker}:** ${commit.text}`);
    }
  }

  if (snapshot.status === "incomplete") {
    lines.push("", "> [!warning] Incomplete session", "> The connection ended before a terminal event was received.");
  } else if (snapshot.terminalReason !== undefined && snapshot.terminalReason !== "final") {
    lines.push("", `*Session ended: ${snapshot.terminalReason}.*`);
  }
  return lines.join("\n");
}

export function formatCommit(milliseconds: number, unstamped = false): string {
  if (unstamped) return `arrival ${milliseconds} · unstamped`;
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = milliseconds % 1_000;
  return `+${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
