import { describe, expect, test } from "bun:test";
import { OAuth2Client } from "google-auth-library";
import { ensureContainerDoc } from "../src/google/container-doc.js";

function fakeAuth(): OAuth2Client {
  // ensureContainerDoc never actually calls anything on `auth` directly — it's
  // only threaded through to google.drive({auth})/google.docs({auth}), which
  // this test bypasses entirely via the driveFiles/docsDocuments seams below.
  return new OAuth2Client();
}

describe("ensureContainerDoc", () => {
  test("reuses an existing folderId and documentId without calling any API", async () => {
    const driveFiles = {
      create: async () => { throw new Error("must not be called when both IDs already exist"); },
      update: async () => { throw new Error("must not be called when both IDs already exist"); },
    };
    const docsDocuments = {
      create: async () => { throw new Error("must not be called when both IDs already exist"); },
    };
    const result = await ensureContainerDoc(
      fakeAuth(),
      { folderId: "existing-folder", documentId: "existing-doc" },
      { driveFiles, docsDocuments } as never,
    );
    expect(result).toEqual({ folderId: "existing-folder", documentId: "existing-doc" });
  });

  test("creates a folder, then a doc, then moves the doc into the folder, when neither exists", async () => {
    const calls: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string; mimeType: string } }) => {
        calls.push(`drive.create:${params.requestBody.mimeType}`);
        expect(params.requestBody.mimeType).toBe("application/vnd.google-apps.folder");
        return { data: { id: "new-folder" } };
      },
      update: async (params: { fileId: string; addParents: string }) => {
        calls.push(`drive.update:${params.fileId}:${params.addParents}`);
        return { data: { id: params.fileId } };
      },
    };
    const docsDocuments = {
      create: async () => {
        calls.push("docs.create");
        return { data: { documentId: "new-doc" } };
      },
    };
    const result = await ensureContainerDoc(fakeAuth(), {}, { driveFiles, docsDocuments } as never);
    expect(result).toEqual({ folderId: "new-folder", documentId: "new-doc" });
    expect(calls).toEqual(["drive.create:application/vnd.google-apps.folder", "docs.create", "drive.update:new-doc:new-folder"]);
  });

  test("defaults the folder/doc name to Shorthand Meeting Notes", async () => {
    const names: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string } }) => {
        names.push(params.requestBody.name);
        return { data: { id: "f1" } };
      },
      update: async () => ({ data: { id: "d1" } }),
    };
    const docsDocuments = {
      create: async (params: { requestBody: { title: string } }) => {
        names.push(params.requestBody.title);
        return { data: { documentId: "d1" } };
      },
    };
    await ensureContainerDoc(fakeAuth(), {}, { driveFiles, docsDocuments } as never);
    expect(names).toEqual(["Shorthand Meeting Notes", "Shorthand Meeting Notes"]);
  });

  test("honours custom folderName/docTitle", async () => {
    const names: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string } }) => { names.push(params.requestBody.name); return { data: { id: "f1" } }; },
      update: async () => ({ data: { id: "d1" } }),
    };
    const docsDocuments = {
      create: async (params: { requestBody: { title: string } }) => { names.push(params.requestBody.title); return { data: { documentId: "d1" } }; },
    };
    await ensureContainerDoc(
      fakeAuth(),
      {},
      { folderName: "My Folder", docTitle: "My Doc", driveFiles, docsDocuments } as never,
    );
    expect(names).toEqual(["My Folder", "My Doc"]);
  });

  test("creates only what's missing: reuses an existing folderId but still creates the doc", async () => {
    const calls: string[] = [];
    const driveFiles = {
      create: async () => { throw new Error("must not create a folder when one already exists"); },
      update: async (params: { fileId: string; addParents: string }) => {
        calls.push(`drive.update:${params.fileId}:${params.addParents}`);
        return { data: { id: params.fileId } };
      },
    };
    const docsDocuments = {
      create: async () => { calls.push("docs.create"); return { data: { documentId: "new-doc" } }; },
    };
    const result = await ensureContainerDoc(
      fakeAuth(),
      { folderId: "existing-folder" },
      { driveFiles, docsDocuments } as never,
    );
    expect(result).toEqual({ folderId: "existing-folder", documentId: "new-doc" });
    expect(calls).toEqual(["docs.create", "drive.update:new-doc:existing-folder"]);
  });

  test("regression: an existing documentId with no folderId still gets moved into the newly-created folder", async () => {
    // This is the picker-flow-then-`--create` combination: a user who previously
    // authenticated via the Picker only ever has a documentId persisted, never a
    // folderId. Running `--create` afterward must create the folder AND move the
    // pre-existing doc into it — not just create the folder and leave the doc
    // wherever it already was.
    const calls: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string; mimeType: string } }) => {
        calls.push(`drive.create:${params.requestBody.mimeType}`);
        return { data: { id: "new-folder" } };
      },
      update: async (params: { fileId: string; addParents: string }) => {
        calls.push(`drive.update:${params.fileId}:${params.addParents}`);
        return { data: { id: params.fileId } };
      },
    };
    const docsDocuments = {
      create: async () => { throw new Error("must not create a doc when one already exists"); },
    };
    const result = await ensureContainerDoc(
      fakeAuth(),
      { documentId: "existing-doc" },
      { driveFiles, docsDocuments } as never,
    );
    expect(result).toEqual({ folderId: "new-folder", documentId: "existing-doc" });
    expect(calls).toEqual([
      "drive.create:application/vnd.google-apps.folder",
      "drive.update:existing-doc:new-folder",
    ]);
  });
});
