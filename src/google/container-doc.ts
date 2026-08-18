import { docs_v1, drive_v3, google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type ContainerDocResult = Readonly<{
  folderId: string;
  documentId: string;
  /** True only when this call created a brand-new folder; false when an existing folderId was reused. */
  folderCreated: boolean;
  /** True only when this call created a brand-new document; false when an existing documentId was reused. */
  documentCreated: boolean;
}>;

const DEFAULT_NAME = "Shorthand Meeting Notes";

export async function ensureContainerDoc(
  auth: OAuth2Client,
  existing: Readonly<{ folderId?: string; documentId?: string }>,
  options?: Readonly<{
    folderName?: string;
    docTitle?: string;
    /** Test seam only; production always uses google.drive({version:"v3",auth}).files. */
    driveFiles?: Pick<drive_v3.Drive["files"], "create" | "update" | "get">;
    /** Test seam only; production always uses google.docs({version:"v1",auth}).documents. */
    docsDocuments?: Pick<docs_v1.Docs["documents"], "create">;
  }>,
): Promise<ContainerDocResult> {
  if (existing.folderId !== undefined && existing.documentId !== undefined) {
    return { folderId: existing.folderId, documentId: existing.documentId, folderCreated: false, documentCreated: false };
  }

  const driveFiles = options?.driveFiles ?? google.drive({ version: "v3", auth }).files;
  const docsDocuments = options?.docsDocuments ?? google.docs({ version: "v1", auth }).documents;

  let folderId = existing.folderId;
  let folderCreated = false;
  if (folderId === undefined) {
    const folder = await driveFiles.create({
      requestBody: {
        name: options?.folderName ?? DEFAULT_NAME,
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id",
    });
    const createdFolderId = folder.data.id;
    if (createdFolderId === null || createdFolderId === undefined) {
      throw new Error("Drive API created a folder but returned no id");
    }
    folderId = createdFolderId;
    folderCreated = true;
  }

  // From here on, if anything throws, the folder above (when folderCreated) is already
  // live in the user's Drive with nothing persisted yet (runGoogleLogin only writes
  // credentials after this function returns) — a bare rethrow would leave the caller
  // with no way to tell the user where that orphaned folder is, and a retry would create
  // a second one. Wrap the rest in try/catch purely to enrich the thrown error with the
  // folder's id when we got far enough to create one; this is deliberately NOT an attempt
  // to persist or recover partial progress (that would mean making documentId optional in
  // mergeCredentials, a larger redesign left for later).
  try {
    let documentId = existing.documentId;
    let documentCreated = false;
    if (documentId === undefined) {
      const doc = await docsDocuments.create({
        requestBody: { title: options?.docTitle ?? options?.folderName ?? DEFAULT_NAME },
      });
      const createdDocumentId = doc.data.documentId;
      if (createdDocumentId === null || createdDocumentId === undefined) {
        throw new Error("Docs API created a document but returned no documentId");
      }
      documentId = createdDocumentId;
      documentCreated = true;
    }

    // documents.create has no `parents` field of its own — placing a file in a
    // folder is always a Drive-API-level operation, regardless of which API
    // created the file. This must run whenever execution reaches here (i.e.
    // whenever the "both already present" early return above didn't fire),
    // not just when the doc was freshly created: a pre-existing documentId
    // paired with a freshly-created folderId (e.g. a picker-flow user, who
    // only ever had a documentId, now running `--create`) still needs the
    // existing doc moved into the new folder.
    //
    // The move must supply BOTH addParents and removeParents, not addParents alone.
    // Google's own documentation for files.update (see the `parents` field's doc
    // comment in node_modules/googleapis/build/src/apis/drive/v3.d.ts) is explicit:
    // "A file can only have one parent folder; specifying multiple parents isn't
    // supported. ... Update requests must use the `addParents` and `removeParents`
    // parameters to modify the parents list." Every file this code moves already has
    // a parent — a freshly-created doc from documents.create is parented to My Drive
    // root, and a picker-selected pre-existing doc is parented wherever the user
    // already keeps it — so addParents alone either fails the request or produces the
    // unsupported multi-parent state Google's docs warn against. Fetch the file's
    // current parents first and pass them back as removeParents (a comma-separated
    // string, per the same doc comment) on the same update call.
    const current = await driveFiles.get({ fileId: documentId, fields: "parents" });
    const currentParents = current.data.parents;
    const removeParents = currentParents !== null && currentParents !== undefined && currentParents.length > 0
      ? currentParents.join(",")
      : undefined;
    await driveFiles.update({
      fileId: documentId,
      addParents: folderId,
      fields: "id",
      ...(removeParents === undefined ? {} : { removeParents }),
    });

    return { folderId, documentId, folderCreated, documentCreated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const decorated = folderCreated
      ? `${message} (a Drive folder was already created before this failure — id: ${folderId}; check Google Drive and either reuse or delete it before retrying, to avoid creating another one)`
      : message;
    throw new Error(decorated, { cause: error });
  }
}
