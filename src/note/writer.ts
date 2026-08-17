import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  appendNoteScaffold,
  detectLineEnding,
  locateAiBlock,
  renderSections,
  type MarkerError,
  type Section,
  type SectionError,
} from "./markers.js";

type WriterFileSystem = {
  access: typeof access;
  open: typeof open;
  readFile: typeof readFile;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
};

const DEFAULT_FILE_SYSTEM: WriterFileSystem = { access, open, readFile, rename, stat, unlink };
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 320] as const;

export type NoteFileErrorCode = "note-missing" | "note-read-only" | "read-failed" | "write-failed";
export type NoteFileError = Readonly<{
  kind: "file-error";
  code: NoteFileErrorCode;
  path: string;
  message: string;
  cause?: unknown;
}>;
export type BlockWriterError = MarkerError | SectionError | NoteFileError;

export type BlockSnapshot = Readonly<{
  body: string;
  hash: string;
  lineEnding: "\r\n" | "\n";
}>;

export type ReadBlockResult =
  | { ok: true; value: BlockSnapshot }
  | { ok: false; error: MarkerError | NoteFileError };

export type WriteSectionsResult =
  | { status: "written"; hash: string }
  | { status: "unchanged"; hash: string }
  | { status: "stale"; expectedHash: string; actualHash: string }
  | { status: "retry"; reason: "outside-edits" | "writer-busy" }
  | { status: "note-locked"; path: string; attempts: number }
  | { status: "error"; error: BlockWriterError };

export type LinkTranscriptResult =
  | { status: "written" }
  | { status: "unchanged" }
  | { status: "retry"; reason: "outside-edits" | "writer-busy" }
  | { status: "note-locked"; path: string; attempts: number }
  | { status: "error"; error: NoteFileError };

// Each status is its own member so this is a genuine discriminated union. Packing
// "written" | "unchanged" into one member makes `status === "written"` unable to
// narrow the member away, so a consumer's trailing `else` still sees it and cannot
// reach `.error`. LinkTranscriptResult above is split for the same reason.
export type EnsureScaffoldResult =
  | { status: "written" }
  | { status: "unchanged" }
  | { status: "retry"; reason: "outside-edits" | "writer-busy" }
  | { status: "note-locked"; path: string; attempts: number }
  | { status: "error"; error: BlockWriterError };

export type BlockWriterOptions = Readonly<{
  fileSystem?: Partial<WriterFileSystem>;
  maxOutsideEditRetries?: number;
}>;

type BlockWriterInternalOptions = Readonly<{
  beforeTemporaryWrite?: () => void | Promise<void>;
}>;

/**
 * The block revision used for optimistic concurrency. Exported so an adapter can
 * derive the same value from a single note read without a second `readCurrentBlock`.
 */
export function hashBlock(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function readCurrentBlock(path: string, options: BlockWriterOptions = {}): Promise<ReadBlockResult> {
  const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  const content = await readNote(path, fileSystem);
  if (!content.ok) return content;
  const located = locateAiBlock(content.value);
  if (!located.ok) return located;
  return {
    ok: true,
    value: {
      body: located.value.body,
      hash: hashBlock(located.value.body),
      lineEnding: detectLineEnding(content.value),
    },
  };
}

export async function writeSections(
  path: string,
  sections: readonly Section[],
  expectedBlockHash: string,
  options: BlockWriterOptions & BlockWriterInternalOptions = {},
): Promise<WriteSectionsResult> {
  let initialRender: ReturnType<typeof renderSections>;
  try {
    initialRender = renderSections(sections);
  } catch (error) {
    return { status: "error", error: invalidSectionError(error) };
  }
  if (!initialRender.ok) return { status: "error", error: initialRender.error };

  const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  const writable = await checkWritable(path, fileSystem);
  if (writable !== undefined) return { status: "error", error: writable };
  const maximumAttempts = options.maxOutsideEditRetries ?? 8;
  let retryReason: "outside-edits" | "writer-busy" = "outside-edits";

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const lock = await acquireLock(path, fileSystem);
    if (!lock.ok) {
      if (lock.error !== "busy") return { status: "error", error: lock.error };
      retryReason = "writer-busy";
      if (attempt + 1 < maximumAttempts) await delay(25 * (attempt + 1));
      continue;
    }

    let temporaryPath: string | undefined;
    try {
      const source = await readNote(path, fileSystem);
      if (!source.ok) return { status: "error", error: source.error };
      const located = locateAiBlock(source.value);
      if (!located.ok) return { status: "error", error: located.error };
      const actualHash = hashBlock(located.value.body);
      if (actualHash !== expectedBlockHash) return { status: "stale", expectedHash: expectedBlockHash, actualHash };

      const lineEnding = detectLineEnding(source.value);
      const rendered = lineEnding === "\n" ? initialRender.value : initialRender.value.replaceAll("\n", lineEnding);
      const replacementBody = rendered.length === 0 ? lineEnding : `${lineEnding}${rendered}${lineEnding}`;
      const updated = source.value.slice(0, located.value.bodyStartOffset) + replacementBody + source.value.slice(located.value.bodyEndOffset);
      if (updated === source.value) return { status: "unchanged", hash: actualHash };

      temporaryPath = temporaryName(path);
      if (options.beforeTemporaryWrite !== undefined) await options.beforeTemporaryWrite();
      await writeSyncedTemporaryFile(temporaryPath, updated, path, fileSystem);
      const renameResult = await verifyAndRename(temporaryPath, path, source.value, fileSystem);
      if (renameResult === "renamed") return { status: "written", hash: hashBlock(replacementBody) };
      if (renameResult === "locked") {
        return { status: "note-locked", path, attempts: RENAME_RETRY_DELAYS_MS.length + 1 };
      }
      if (renameResult !== "outside-edit") return { status: "error", error: renameResult };
      retryReason = "outside-edits";
    } catch (error) {
      return { status: "error", error: fileError(path, errno(error) === "ENOENT" ? "note-missing" : "write-failed", error) };
    } finally {
      if (temporaryPath !== undefined) await fileSystem.unlink(temporaryPath).catch(() => {});
      await releaseLock(lock.path, fileSystem);
    }
    if (attempt + 1 < maximumAttempts) await delay(25 * (attempt + 1));
  }
  return { status: "retry", reason: retryReason };
}

export async function linkTranscriptFrontmatter(
  path: string,
  transcriptWikilink: string,
  options: BlockWriterOptions = {},
): Promise<LinkTranscriptResult> {
  const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  const writable = await checkWritable(path, fileSystem);
  if (writable !== undefined) return { status: "error", error: writable };
  const maximumAttempts = options.maxOutsideEditRetries ?? 8;
  let retryReason: "outside-edits" | "writer-busy" = "outside-edits";
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const lock = await acquireLock(path, fileSystem);
    if (!lock.ok) {
      if (lock.error !== "busy") return { status: "error", error: lock.error };
      retryReason = "writer-busy";
      if (attempt + 1 < maximumAttempts) await delay(25 * (attempt + 1));
      continue;
    }
    let temporaryPath: string | undefined;
    try {
      const source = await readNote(path, fileSystem);
      if (!source.ok) return { status: "error", error: source.error };
      const updated = spliceTranscriptFrontmatter(source.value, transcriptWikilink);
      if (updated === source.value) return { status: "unchanged" };
      temporaryPath = temporaryName(path);
      await writeSyncedTemporaryFile(temporaryPath, updated, path, fileSystem);
      const renameResult = await verifyAndRename(temporaryPath, path, source.value, fileSystem);
      if (renameResult === "renamed") return { status: "written" };
      if (renameResult === "locked") return { status: "note-locked", path, attempts: RENAME_RETRY_DELAYS_MS.length + 1 };
      if (renameResult !== "outside-edit") return { status: "error", error: renameResult };
      retryReason = "outside-edits";
    } catch (error) {
      return { status: "error", error: fileError(path, errno(error) === "ENOENT" ? "note-missing" : "write-failed", error) };
    } finally {
      if (temporaryPath !== undefined) await fileSystem.unlink(temporaryPath).catch(() => {});
      await releaseLock(lock.path, fileSystem);
    }
    if (attempt + 1 < maximumAttempts) await delay(25 * (attempt + 1));
  }
  return { status: "retry", reason: retryReason };
}

/** Add the marker scaffold to an existing note through the core atomic writer. */
export async function ensureNoteScaffold(
  path: string,
  sections: readonly Section[],
  options: BlockWriterOptions = {},
): Promise<EnsureScaffoldResult> {
  const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  const writable = await checkWritable(path, fileSystem);
  if (writable !== undefined) return { status: "error", error: writable };
  const maximumAttempts = options.maxOutsideEditRetries ?? 8;
  let retryReason: "outside-edits" | "writer-busy" = "outside-edits";

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const lock = await acquireLock(path, fileSystem);
    if (!lock.ok) {
      if (lock.error !== "busy") return { status: "error", error: lock.error };
      retryReason = "writer-busy";
      if (attempt + 1 < maximumAttempts) await delay(25 * (attempt + 1));
      continue;
    }
    let temporaryPath: string | undefined;
    try {
      const source = await readNote(path, fileSystem);
      if (!source.ok) return { status: "error", error: source.error };
      const updated = appendNoteScaffold(source.value, sections);
      if (!updated.ok) return { status: "error", error: updated.error };
      if (updated.value === source.value) return { status: "unchanged" };
      temporaryPath = temporaryName(path);
      await writeSyncedTemporaryFile(temporaryPath, updated.value, path, fileSystem);
      const renameResult = await verifyAndRename(temporaryPath, path, source.value, fileSystem);
      if (renameResult === "renamed") return { status: "written" };
      if (renameResult === "locked") return { status: "note-locked", path, attempts: RENAME_RETRY_DELAYS_MS.length + 1 };
      if (renameResult !== "outside-edit") return { status: "error", error: renameResult };
      retryReason = "outside-edits";
    } catch (error) {
      return { status: "error", error: fileError(path, errno(error) === "ENOENT" ? "note-missing" : "write-failed", error) };
    } finally {
      if (temporaryPath !== undefined) await fileSystem.unlink(temporaryPath).catch(() => {});
      await releaseLock(lock.path, fileSystem);
    }
    if (attempt + 1 < maximumAttempts) await delay(25 * (attempt + 1));
  }
  return { status: "retry", reason: retryReason };
}

function spliceTranscriptFrontmatter(content: string, wikilink: string): string {
  const lineEnding = detectLineEnding(content);
  const value = `handy-transcript: "[[${wikilink.replaceAll("\\", "/").replace(/\.md$/i, "").replaceAll('"', '\\"')}]]"`;
  const opening = /^---(?:\r\n|\n)/.exec(content);
  if (opening === null) return `---${lineEnding}${value}${lineEnding}---${lineEnding}${content}`;
  const frontmatterStart = opening[0].length;
  const closing = /^---[ \t]*\r?$/m.exec(content.slice(frontmatterStart));
  if (closing === null) return `---${lineEnding}${value}${lineEnding}---${lineEnding}${content}`;
  const closingOffset = frontmatterStart + closing.index;
  const key = /^handy-transcript:[^\r\n]*$/m.exec(content.slice(frontmatterStart, closingOffset));
  if (key !== null) {
    const keyOffset = frontmatterStart + key.index;
    return content.slice(0, keyOffset) + value + content.slice(keyOffset + key[0].length);
  }
  return content.slice(0, closingOffset) + `${value}${lineEnding}` + content.slice(closingOffset);
}

async function checkWritable(path: string, fileSystem: WriterFileSystem): Promise<NoteFileError | undefined> {
  try {
    // Best-effort TOCTOU checks only; the actual open and rename remain authoritative.
    await fileSystem.access(path, constants.W_OK);
    await fileSystem.access(dirname(path), constants.W_OK);
  } catch (error) {
    return fileError(path, errno(error) === "ENOENT" ? "note-missing" : "note-read-only", error);
  }
  return undefined;
}

async function acquireLock(
  path: string,
  fileSystem: WriterFileSystem,
): Promise<{ ok: true; path: string } | { ok: false; error: "busy" | NoteFileError }> {
  const lockPath = join(dirname(path), `.${basename(path)}.shorthand-notes.lock`);
  try {
    const handle = await fileSystem.open(lockPath, "wx");
    await handle.close();
    return { ok: true, path: lockPath };
  } catch (error) {
    if (errno(error) === "EEXIST") return { ok: false, error: "busy" };
    return { ok: false, error: fileError(path, "write-failed", error) };
  }
}

async function releaseLock(path: string, fileSystem: WriterFileSystem): Promise<void> {
  await fileSystem.unlink(path).catch(() => {});
}

async function writeSyncedTemporaryFile(
  temporaryPath: string,
  content: string,
  targetPath: string,
  fileSystem: WriterFileSystem,
): Promise<void> {
  const target = await fileSystem.stat(targetPath);
  const handle = await fileSystem.open(temporaryPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    if (process.platform !== "win32") await handle.chmod(target.mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyAndRename(
  temporaryPath: string,
  path: string,
  expectedSource: string,
  fileSystem: WriterFileSystem,
): Promise<"renamed" | "outside-edit" | "locked" | NoteFileError> {
  for (let retry = 0; retry <= RENAME_RETRY_DELAYS_MS.length; retry += 1) {
    if (retry > 0) {
      await delay(RENAME_RETRY_DELAYS_MS[retry - 1]!);
      const verification = await readNote(path, fileSystem);
      if (!verification.ok) return verification.error;
      if (verification.value !== expectedSource) return "outside-edit";
    } else {
      const verification = await readNote(path, fileSystem);
      if (!verification.ok) return verification.error;
      if (verification.value !== expectedSource) return "outside-edit";
    }
    try {
      await fileSystem.rename(temporaryPath, path);
      return "renamed";
    } catch (error) {
      if (!isRenameContention(error)) {
        return fileError(path, errno(error) === "ENOENT" ? "note-missing" : "write-failed", error);
      }
      if (retry === RENAME_RETRY_DELAYS_MS.length) return "locked";
    }
  }
  return "locked";
}

async function readNote(path: string, fileSystem: WriterFileSystem): Promise<{ ok: true; value: string } | { ok: false; error: NoteFileError }> {
  try {
    return { ok: true, value: await fileSystem.readFile(path, "utf8") };
  } catch (error) {
    return { ok: false, error: fileError(path, errno(error) === "ENOENT" ? "note-missing" : "read-failed", error) };
  }
}

function temporaryName(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

function isRenameContention(error: unknown): boolean {
  return ["EPERM", "EACCES", "EBUSY"].includes(errno(error) ?? "");
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function fileError(path: string, code: NoteFileErrorCode, cause?: unknown): NoteFileError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return { kind: "file-error", code, path, message: `${code} for ${path}${detail}`, ...(cause === undefined ? {} : { cause }) };
}

function invalidSectionError(cause: unknown): SectionError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return { kind: "section-error", code: "invalid-section", sectionIndex: -1, message: `Invalid sections input${detail}` };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
