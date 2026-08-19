import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { shorthandConfigDirectory } from "../config.js";
import { GoogleApiDocsClient, type GoogleDocsApi } from "./docs-client.js";
import { GoogleDocsNoteSink } from "./docs-sink.js";
import { credentialsPath as defaultCredentialsPath, FileTokenProvider, readCredentials } from "./file-token-provider.js";

/**
 * Where core reaches `GoogleDocsNoteSink` from: mints a tab via `addDocumentTab`
 * on first use of a note, persists it keyed by a hash of the note's path, and
 * reuses it on every later call for the same note — until the credentials
 * file's `document_id` changes, at which point a fresh tab is minted in the
 * new target document. See docs/superpowers/specs/2026-08-19-enhance-google-sink-design.md.
 *
 * `--dry-run --sink google` still mints/writes a real tab: `EnhanceRunner` calls
 * `sink.read()` even during a dry run, which requires a real, live tab to exist, so
 * resolving a Google sink has the same mint-or-reuse side effects for a dry run as for a
 * real run — even though no AI sections get written back. This is a deliberate trade-off,
 * not a bug.
 *
 * A tab deleted by the user from inside the Google Doc poisons the persisted state: the
 * `captures/<id>.json` file keeps pointing at a `tabId` that no longer exists, and every
 * future run for that note fails with an `invalid-target` read error rather than
 * self-healing. Deleting the corresponding `captures/<id>.json` file forces a fresh tab to
 * be minted on the next run. (Automatic re-minting on `invalid-target` is a separate,
 * bigger design decision left for later.)
 */

export type ResolveGoogleSinkOptions = Readonly<{
  credentialsPath?: string;
  capturesDirectory?: string;
  /** Test seam only; production always builds a GoogleApiDocsClient. */
  api?: GoogleDocsApi;
}>;

export type ResolveGoogleSinkResult =
  | Readonly<{ ok: true; sink: GoogleDocsNoteSink }>
  | Readonly<{ ok: false; message: string }>;

type CaptureState = Readonly<{ documentId: string; tabId: string; createdAt: string }>;

export async function resolveGoogleDocsSink(
  notePath: string,
  environment: NodeJS.ProcessEnv,
  options: ResolveGoogleSinkOptions = {},
): Promise<ResolveGoogleSinkResult> {
  const credsPath = options.credentialsPath ?? defaultCredentialsPath(environment);
  const credentials = await readCredentials(credsPath);
  if (!credentials.ok) return { ok: false, message: credentials.message };

  const documentId = credentials.value.document_id;
  if (documentId === undefined) {
    return { ok: false, message: "No Google Doc selected; connect your Google account and choose a target document, then retry." };
  }

  const capturesDirectory = options.capturesDirectory ?? join(shorthandConfigDirectory(environment), "captures");
  const statePath = join(capturesDirectory, `${captureIdFor(notePath)}.json`);
  const api = options.api ?? new GoogleApiDocsClient(new FileTokenProvider({ credentialsPath: credsPath }));

  let tabId = await reusableTabId(statePath, documentId);
  if (tabId === undefined) {
    const title = basename(notePath, extname(notePath));
    const minted = await api.addDocumentTab(documentId, title);
    if (!minted.ok) return { ok: false, message: `Could not create a Google Docs tab: ${minted.error.message}` };
    tabId = minted.value.tabId;
    const state: CaptureState = { documentId, tabId, createdAt: new Date().toISOString() };
    await mkdir(capturesDirectory, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  return { ok: true, sink: new GoogleDocsNoteSink({ documentId, tabId, api }) };
}

/**
 * NTFS is case-insensitive but case-preserving, so two invocations of the
 * same note differing only by path case must reach the same id on Windows —
 * otherwise a crash-resume with a differently-cased path would silently mint
 * a second tab. Other platforms are case-sensitive; lowercasing there would
 * wrongly collide two different files.
 */
function captureIdFor(notePath: string): string {
  const resolved = resolve(notePath);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * A missing or unparseable state file is a cache miss, not a failure — this
 * always resolves to `undefined` rather than throwing or rejecting, so a
 * corrupt file (this is a disposable cache, not authoritative data) never
 * surfaces as an error to the caller.
 */
async function reusableTabId(statePath: string, documentId: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CaptureState>;
    if (parsed.documentId === documentId && typeof parsed.tabId === "string" && parsed.tabId.length > 0) {
      return parsed.tabId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
