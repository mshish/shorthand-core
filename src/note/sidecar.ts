import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sessionKey, type SessionSnapshot, type TranscriptUpdate } from "../stream/transcript.js";

export const SIDECAR_SENTINEL = "# Handy Transcript";
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

export type SidecarWriterOptions = {
  flushIntervalMs?: number;
  now?: () => Date;
  fileSystem?: Partial<SidecarFileSystem>;
};

type TimelineEntry =
  | { type: "session"; key: string }
  | { type: "gap"; id: number; text: string };

const DEFAULT_FILE_SYSTEM: SidecarFileSystem = { mkdir, open, readFile, rename, unlink };

export class SidecarWriter extends EventEmitter {
  readonly #sessions = new Map<string, SessionSnapshot>();
  #timeline: TimelineEntry[] = [];
  readonly #flushIntervalMs: number;
  readonly #now: () => Date;
  readonly #fs: SidecarFileSystem;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #persisted = "";
  #base = HEADER.trimEnd();
  #ready: Promise<void>;
  #readyError: unknown;
  #writeChain: Promise<void> = Promise.resolve();
  #targetEstablished = false;
  #gapId = 0;
  #temporaryId = 0;

  constructor(readonly path: string, options: SidecarWriterOptions = {}) {
    super();
    this.#flushIntervalMs = options.flushIntervalMs ?? 250;
    this.#now = options.now ?? (() => new Date());
    this.#fs = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
    this.#ready = this.#startInitialization();
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
      text: `> [!warning] Transcript gap\n> Reconnected as connection generation ${connectionGeneration}. Handy does not replay missed events.`,
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
    const sections = this.#timeline.flatMap((entry) => {
      if (entry.type === "gap") return [entry.text];
      const snapshot = this.#sessions.get(entry.key);
      return snapshot === undefined ? [] : [renderSession(snapshot)];
    });
    return [this.#base, ...sections].join("\n\n");
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch(() => {});
    }, this.#flushIntervalMs);
  }

  async #ensureReady(): Promise<void> {
    await this.#ready;
    if (this.#readyError !== undefined) {
      const error = this.#readyError;
      this.#readyError = undefined;
      this.#ready = this.#startInitialization();
      throw error;
    }
  }

  #startInitialization(): Promise<void> {
    return this.#initialize().catch((error: unknown) => {
      this.#readyError = error;
    });
  }

  async #initialize(): Promise<void> {
    await this.#fs.mkdir(dirname(this.path), { recursive: true });
    try {
      const existing = await this.#fs.readFile(this.path, "utf8");
      this.#adoptExisting(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #flushOnce(): Promise<void> {
    await this.#ensureReady();
    if (!this.#targetEstablished) {
      try {
        this.#adoptExisting(await this.#fs.readFile(this.path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      let current: string;
      try {
        current = await this.#fs.readFile(this.path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Sidecar disappeared during capture: ${this.path}`);
        }
        throw error;
      }
      if (current !== this.#persisted) {
        throw new Error(`Sidecar changed outside Shorthand during capture: ${this.path}`);
      }
    }

    const rendered = this.render();
    if (rendered === this.#persisted) return;
    const temporaryPath = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.${this.#temporaryId++}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await this.#fs.open(temporaryPath, "wx");
      await handle.writeFile(rendered, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#fs.rename(temporaryPath, this.path);
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.#fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
    this.#persisted = rendered;
    this.#targetEstablished = true;
  }

  #adoptExisting(existing: string): void {
    const firstLine = existing.split(/\r?\n/, 1)[0];
    if (firstLine !== SIDECAR_SENTINEL) {
      throw new Error(`Refusing to overwrite ${this.path}: first line must be "${SIDECAR_SENTINEL}".`);
    }
    this.#targetEstablished = true;
    this.#persisted = existing;
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    this.#base = `${existing}${separator}## Resumed ${this.#now().toISOString()}`;
  }
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
