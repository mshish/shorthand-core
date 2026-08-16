import { readFile } from "node:fs/promises";
import {
  AI_BLOCK_START,
  USER_NOTES_MARKER,
  locateAiBlock,
  parseSections,
  type MarkerError,
  type Section,
  type SectionError,
} from "./markers.js";
import {
  hashBlock,
  writeSections,
  type BlockWriterError,
  type BlockWriterOptions,
  type NoteFileErrorCode,
  type WriteSectionsResult,
} from "./writer.js";
import { sinkError, type NoteSink, type SinkError, type SinkReadResult, type SinkWriteResult } from "./sink.js";

/**
 * Lock contention on the note is transient but not instantaneous — OneDrive and
 * Obsidian typically release within a beat. Reported so a caller can back off.
 */
const LOCK_RETRY_AFTER_MS = 250;

export type MarkdownNoteSinkOptions = Readonly<{
  notePath: string;
  /**
   * Vault root offered to the agent as read-only context. Omit it and the sink
   * behaves like an API sink: no `agentContext`, so no vault tools.
   */
  vaultRoot?: string;
  writerOptions?: BlockWriterOptions;
  /** Test seam only; production always reads the real file. */
  readNote?: (path: string) => Promise<string>;
  /** Test seam only; production always uses the atomic block writer. */
  write?: (
    path: string,
    sections: readonly Section[],
    expectedBlockHash: string,
    options?: BlockWriterOptions,
  ) => Promise<WriteSectionsResult>;
}>;

/**
 * The reference `NoteSink`: an ownership-marked Markdown note on disk.
 *
 * It adapts `writeSections` rather than reimplementing it, so the atomic
 * replace, lock retry, and "bytes outside the markers are never touched"
 * guarantees are exactly the ones covered by the writer's own tests.
 */
export class MarkdownNoteSink implements NoteSink {
  readonly agentContext?: { cwd: string };
  readonly describe: string;
  readonly #notePath: string;
  readonly #writerOptions: BlockWriterOptions;
  readonly #readNote: (path: string) => Promise<string>;
  readonly #write: (
    path: string,
    sections: readonly Section[],
    expectedBlockHash: string,
    options?: BlockWriterOptions,
  ) => Promise<WriteSectionsResult>;

  constructor(options: MarkdownNoteSinkOptions) {
    this.#notePath = options.notePath;
    this.#writerOptions = options.writerOptions ?? {};
    // An injected filesystem must be honoured on read as well as write, or a caller
    // that swaps the filesystem gets a sink reading one store and writing another.
    const readNoteFile = this.#writerOptions.fileSystem?.readFile ?? readFile;
    this.#readNote = options.readNote ?? ((path) => readNoteFile(path, "utf8") as Promise<string>);
    this.#write = options.write ?? writeSections;
    this.describe = options.notePath;
    if (options.vaultRoot !== undefined) this.agentContext = { cwd: options.vaultRoot };
  }

  /**
   * One file read yields sections, user notes, and revision. Reading them
   * separately would let them skew across an outside edit.
   */
  async read(): Promise<SinkReadResult> {
    let content: string;
    try {
      content = await this.#readNote(this.#notePath);
    } catch (error) {
      return { ok: false, error: fileSinkError(this.#notePath, errno(error) === "ENOENT" ? "note-missing" : "read-failed", error) };
    }
    const located = locateAiBlock(content);
    if (!located.ok) return { ok: false, error: markerSinkError(located.error) };
    const parsed = parseSections(located.value.body);
    if (!parsed.ok) return { ok: false, error: sectionSinkError(parsed.error) };
    return {
      ok: true,
      value: {
        sections: parsed.value,
        userNotes: extractUserNotes(content),
        revision: hashBlock(located.value.body),
      },
    };
  }

  async write(sections: readonly Section[], expectedRevision: string): Promise<SinkWriteResult> {
    const result = await this.#write(this.#notePath, sections, expectedRevision, this.#writerOptions);
    if (result.status === "written") return { status: "written", revision: result.hash };
    if (result.status === "unchanged") return { status: "unchanged", revision: result.hash };
    if (result.status === "stale") return { status: "stale" };
    if (result.status === "retry") return { status: "busy" };
    if (result.status === "note-locked") return { status: "busy", retryAfterMs: LOCK_RETRY_AFTER_MS };
    return { status: "error", error: writerSinkError(result.error) };
  }
}

/** The user-owned prose between the notes marker and the AI block. */
export function extractUserNotes(noteContent: string): string {
  const notesStart = noteContent.indexOf(USER_NOTES_MARKER);
  const aiStart = noteContent.indexOf(AI_BLOCK_START);
  if (notesStart < 0 || aiStart < notesStart) return "";
  return noteContent.slice(notesStart + USER_NOTES_MARKER.length, aiStart).replace(/^\s+|\s+$/g, "");
}

function writerSinkError(error: BlockWriterError): SinkError {
  if (error.kind === "marker-error") return markerSinkError(error);
  if (error.kind === "section-error") return sectionSinkError(error);
  return sinkError(fileErrorCode(error.code), error.message, error);
}

function markerSinkError(error: MarkerError): SinkError {
  return sinkError("invalid-target", error.message, error);
}

function sectionSinkError(error: SectionError): SinkError {
  return sinkError("invalid-content", error.message, error);
}

function fileErrorCode(code: NoteFileErrorCode): SinkError["code"] {
  if (code === "note-missing") return "not-found";
  if (code === "note-read-only") return "forbidden";
  return "transport";
}

/** Mirrors `NoteFileError`'s message shape so failure text is identical to the writer's. */
function fileSinkError(path: string, code: NoteFileErrorCode, cause: unknown): SinkError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return sinkError(fileErrorCode(code), `${code} for ${path}${detail}`, cause);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
