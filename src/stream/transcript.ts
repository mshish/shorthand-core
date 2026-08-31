import type { WireEvent } from "./client.js";

export type Speaker = "me" | "them";
export type SessionStatus = "active" | "terminal" | "incomplete";
export type TerminalReason = "final" | "no_speech" | "cancel" | "error";

export type TranscriptCommit = {
  speaker: Speaker;
  text: string;
  commitMs: number;
  unstamped: boolean;
  sequence: number;
};

export type SpeakerTranscript = {
  speaker: Speaker;
  text: string;
  commitMs: number;
  unstamped: boolean;
};

export type FinalTranscript = {
  text: string;
  speaker?: Speaker;
  commitMs: number;
  unstamped: boolean;
};

export type SessionSnapshot = {
  connectionGeneration: number;
  session: number;
  status: SessionStatus;
  terminalReason?: TerminalReason;
  speakers: readonly SpeakerTranscript[];
  commits: readonly TranscriptCommit[];
  final?: FinalTranscript;
};

export type TranscriptUpdate = {
  action: "begin" | "append" | "rewrite-tail" | "replace-session" | "terminate" | "incomplete";
  delta?: string;
  speaker?: Speaker;
  commitMs?: number;
  unstamped?: boolean;
  preservedPrefixLength?: number;
  snapshot: SessionSnapshot;
};

type MutableSession = {
  connectionGeneration: number;
  session: number;
  status: SessionStatus;
  terminalReason?: TerminalReason;
  speakerText: Map<Speaker, string>;
  commits: TranscriptCommit[];
  orderingFloor: number;
  final?: FinalTranscript;
};

export function sessionKey(connectionGeneration: number, session: number): string {
  return `${connectionGeneration}:${session}`;
}

function longestCommonPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export class TranscriptStore {
  readonly #sessions = new Map<string, MutableSession>();
  #sequence = 0;

  ingest(connectionGeneration: number, event: WireEvent): TranscriptUpdate | null {
    // `idle`/`refused`/`start_failed` carry no `session`, exactly like `hello` — see
    // client.ts's `WireEvent` comment. None of the three belongs to a capture, so a
    // transcript store has nothing to do with one: it must be excluded here rather than
    // reaching `event.session` below (which does not exist on any of the three) or the
    // terminal-reason fallthrough at the bottom of this method (which would otherwise
    // treat "idle" as a `TerminalReason` a session ended with).
    if (event.t === "hello" || event.t === "idle" || event.t === "refused" || event.t === "start_failed") return null;
    const key = sessionKey(connectionGeneration, event.session);

    if (event.t === "begin") {
      const existing = this.#sessions.get(key);
      if (existing !== undefined) return null;
      const created: MutableSession = {
        connectionGeneration,
        session: event.session,
        status: "active",
        speakerText: new Map(),
        commits: [],
        orderingFloor: event.session_elapsed_ms ?? 0,
      };
      this.#sessions.set(key, created);
      return { action: "begin", snapshot: this.#snapshot(created) };
    }

    const state = this.#sessions.get(key) ?? this.#createImplicit(connectionGeneration, event.session);
    if (state.status !== "active") return null;

    if (event.t === "partial") {
      const previous = state.speakerText.get(event.speaker) ?? "";
      if (event.committed === previous) return null;

      const extendsPrefix = event.committed.startsWith(previous);
      const preservedPrefixLength = extendsPrefix ? previous.length : longestCommonPrefix(previous, event.committed);
      const delta = event.committed.slice(preservedPrefixLength);
      const { commitMs, unstamped } = this.#stamp(state, event.session_elapsed_ms);

      if (!extendsPrefix) this.#preserveSpeakerPrefix(state, event.speaker, preservedPrefixLength);
      if (delta.length > 0) {
        state.commits.push({
          speaker: event.speaker,
          text: delta,
          commitMs,
          unstamped,
          sequence: this.#sequence++,
        });
      }
      state.speakerText.set(event.speaker, event.committed);
      return {
        action: extendsPrefix ? "append" : "rewrite-tail",
        delta,
        speaker: event.speaker,
        commitMs,
        unstamped,
        ...(!extendsPrefix ? { preservedPrefixLength } : {}),
        snapshot: this.#snapshot(state),
      };
    }

    if (event.t === "final") {
      const { commitMs, unstamped } = this.#stamp(state, event.session_elapsed_ms);
      state.final = {
        text: event.text,
        ...(event.speaker === undefined ? {} : { speaker: event.speaker }),
        commitMs,
        unstamped,
      };
      state.status = "terminal";
      state.terminalReason = "final";
      return { action: "replace-session", snapshot: this.#snapshot(state) };
    }

    state.status = "terminal";
    state.terminalReason = event.t;
    return { action: "terminate", snapshot: this.#snapshot(state) };
  }

  markConnectionEnded(connectionGeneration: number): TranscriptUpdate[] {
    const updates: TranscriptUpdate[] = [];
    for (const state of this.#sessions.values()) {
      if (state.connectionGeneration === connectionGeneration && state.status === "active") {
        state.status = "incomplete";
        updates.push({ action: "incomplete", snapshot: this.#snapshot(state) });
      }
    }
    return updates;
  }

  snapshots(): SessionSnapshot[] {
    return [...this.#sessions.values()].map((state) => this.#snapshot(state));
  }

  transcriptText(): string {
    return this.snapshots()
      .map((snapshot) => {
        if (snapshot.final !== undefined) return snapshot.final.text;
        return snapshot.commits
          .filter((commit) => commit.text.length > 0)
          .map((commit) => `${commit.speaker}: ${commit.text}`)
          .join("\n");
      })
      .filter((text) => text.length > 0)
      .join("\n\n");
  }

  #createImplicit(connectionGeneration: number, session: number): MutableSession {
    const key = sessionKey(connectionGeneration, session);
    const state: MutableSession = {
      connectionGeneration,
      session,
      status: "active",
      speakerText: new Map(),
      commits: [],
      orderingFloor: 0,
    };
    this.#sessions.set(key, state);
    return state;
  }

  #stamp(state: MutableSession, elapsed: number | undefined): { commitMs: number; unstamped: boolean } {
    if (elapsed !== undefined) {
      state.orderingFloor = Math.max(state.orderingFloor, elapsed);
      return { commitMs: elapsed, unstamped: false };
    }
    state.orderingFloor += 1;
    return { commitMs: state.orderingFloor, unstamped: true };
  }

  #preserveSpeakerPrefix(state: MutableSession, speaker: Speaker, prefixLength: number): void {
    let remaining = prefixLength;
    const next: TranscriptCommit[] = [];
    for (const commit of state.commits) {
      if (commit.speaker !== speaker) {
        next.push(commit);
        continue;
      }
      if (remaining <= 0) continue;
      if (commit.text.length <= remaining) {
        next.push(commit);
        remaining -= commit.text.length;
      } else {
        next.push({ ...commit, text: commit.text.slice(0, remaining) });
        remaining = 0;
      }
    }
    state.commits = next;
  }

  #snapshot(state: MutableSession): SessionSnapshot {
    const commits = [...state.commits]
      .sort((left, right) => left.commitMs - right.commitMs || left.sequence - right.sequence)
      .map((commit) => ({ ...commit }));
    const speakers = [...state.speakerText.entries()]
      .map(([speaker, text]) => {
        const latest = commits.filter((commit) => commit.speaker === speaker).at(-1);
        return {
          speaker,
          text,
          commitMs: latest?.commitMs ?? 0,
          unstamped: latest?.unstamped ?? true,
        };
      })
      .sort((left, right) => left.commitMs - right.commitMs || left.speaker.localeCompare(right.speaker));
    return {
      connectionGeneration: state.connectionGeneration,
      session: state.session,
      status: state.status,
      ...(state.terminalReason === undefined ? {} : { terminalReason: state.terminalReason }),
      speakers,
      commits,
      ...(state.final === undefined ? {} : { final: { ...state.final } }),
    };
  }
}

export function enhancementDelta(update: TranscriptUpdate): string {
  if (update.action === "append" && update.delta !== undefined && update.speaker !== undefined) {
    return `${update.speaker}: ${update.delta}`;
  }
  if (update.action === "rewrite-tail" && update.delta !== undefined && update.speaker !== undefined) {
    return `[correction to earlier ${update.speaker} transcript] ${update.delta}`;
  }
  if (update.action === "replace-session" && update.snapshot.final !== undefined) {
    const previouslyCommitted = update.snapshot.commits.reduce((total, commit) => total + commit.text.length, 0);
    const newTail = update.snapshot.final.text.slice(Math.min(previouslyCommitted, update.snapshot.final.text.length));
    if (newTail.length === 0) return "";
    const speaker = update.snapshot.final.speaker ?? "merged speakers";
    return `[final correction for session ${update.snapshot.session}, already-sent prefix omitted, ${speaker}] ${newTail}`;
  }
  return "";
}
