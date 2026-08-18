import { docs_v1, drive_v3, google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type ContainerDocResult = Readonly<{ folderId: string; documentId: string }>;

const DEFAULT_NAME = "Shorthand Meeting Notes";

export async function ensureContainerDoc(
  auth: OAuth2Client,
  existing: Readonly<{ folderId?: string; documentId?: string }>,
  options?: Readonly<{
    folderName?: string;
    docTitle?: string;
    /** Test seam only; production always uses google.drive({version:"v3",auth}).files. */
    driveFiles?: Pick<drive_v3.Drive["files"], "create" | "update">;
    /** Test seam only; production always uses google.docs({version:"v1",auth}).documents. */
    docsDocuments?: Pick<docs_v1.Docs["documents"], "create">;
  }>,
): Promise<ContainerDocResult> {
  if (existing.folderId !== undefined && existing.documentId !== undefined) {
    return { folderId: existing.folderId, documentId: existing.documentId };
  }

  const driveFiles = options?.driveFiles ?? google.drive({ version: "v3", auth }).files;
  const docsDocuments = options?.docsDocuments ?? google.docs({ version: "v1", auth }).documents;

  let folderId = existing.folderId;
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
  }

  let documentId = existing.documentId;
  if (documentId === undefined) {
    const doc = await docsDocuments.create({
      requestBody: { title: options?.docTitle ?? options?.folderName ?? DEFAULT_NAME },
    });
    const createdDocumentId = doc.data.documentId;
    if (createdDocumentId === null || createdDocumentId === undefined) {
      throw new Error("Docs API created a document but returned no documentId");
    }
    documentId = createdDocumentId;
  }

  // documents.create has no `parents` field of its own — placing a file in a
  // folder is always a Drive-API-level operation, regardless of which API
  // created the file. This must run whenever execution reaches here (i.e.
  // whenever the "both already present" early return above didn't fire),
  // not just when the doc was freshly created: a pre-existing documentId
  // paired with a freshly-created folderId (e.g. a picker-flow user, who
  // only ever had a documentId, now running `--create`) still needs the
  // existing doc moved into the new folder.
  await driveFiles.update({ fileId: documentId, addParents: folderId, fields: "id" });

  return { folderId, documentId };
}
