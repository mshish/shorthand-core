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
      get: async () => { throw new Error("must not be called when both IDs already exist"); },
    };
    const docsDocuments = {
      create: async () => { throw new Error("must not be called when both IDs already exist"); },
    };
    const result = await ensureContainerDoc(
      fakeAuth(),
      { folderId: "existing-folder", documentId: "existing-doc" },
      { driveFiles, docsDocuments } as never,
    );
    expect(result).toEqual({
      folderId: "existing-folder",
      documentId: "existing-doc",
      folderCreated: false,
      documentCreated: false,
    });
  });

  test("creates a folder, then a doc, then moves the doc into the folder, when neither exists", async () => {
    const calls: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string; mimeType: string } }) => {
        calls.push(`drive.create:${params.requestBody.mimeType}`);
        expect(params.requestBody.mimeType).toBe("application/vnd.google-apps.folder");
        return { data: { id: "new-folder" } };
      },
      get: async (params: { fileId: string }) => {
        calls.push(`drive.get:${params.fileId}`);
        return { data: { parents: ["old-parent-id"] } };
      },
      update: async (params: { fileId: string; addParents: string; removeParents?: string }) => {
        calls.push(`drive.update:${params.fileId}:${params.addParents}:${params.removeParents}`);
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
    expect(result).toEqual({ folderId: "new-folder", documentId: "new-doc", folderCreated: true, documentCreated: true });
    expect(calls).toEqual([
      "drive.create:application/vnd.google-apps.folder",
      "docs.create",
      "drive.get:new-doc",
      "drive.update:new-doc:new-folder:old-parent-id",
    ]);
  });

  // Regression test for the addParents-without-removeParents bug: proves the exact
  // update() call params include both addParents (the new folder) and removeParents
  // (whatever files.get reported as the file's current parents), for the "neither
  // folder nor doc exists" creation path.
  test("regression: the move includes removeParents sourced from files.get, not just addParents", async () => {
    const updateCalls: Array<{ fileId: string; addParents: string; removeParents?: string; fields: string }> = [];
    const driveFiles = {
      create: async () => ({ data: { id: "new-folder" } }),
      get: async () => ({ data: { parents: ["old-parent-id"] } }),
      update: async (params: { fileId: string; addParents: string; removeParents?: string; fields: string }) => {
        updateCalls.push(params);
        return { data: { id: params.fileId } };
      },
    };
    const docsDocuments = {
      create: async () => ({ data: { documentId: "new-doc" } }),
    };
    await ensureContainerDoc(fakeAuth(), {}, { driveFiles, docsDocuments } as never);
    expect(updateCalls).toEqual([
      { fileId: "new-doc", addParents: "new-folder", removeParents: "old-parent-id", fields: "id" },
    ]);
  });

  test("regression: tolerates a file with no current parents by omitting removeParents", async () => {
    const updateCalls: Array<{ fileId: string; addParents: string; removeParents?: string; fields: string }> = [];
    const driveFiles = {
      create: async () => ({ data: { id: "new-folder" } }),
      get: async () => ({ data: { parents: [] } }),
      update: async (params: { fileId: string; addParents: string; removeParents?: string; fields: string }) => {
        updateCalls.push(params);
        return { data: { id: params.fileId } };
      },
    };
    const docsDocuments = {
      create: async () => ({ data: { documentId: "new-doc" } }),
    };
    await ensureContainerDoc(fakeAuth(), {}, { driveFiles, docsDocuments } as never);
    expect(updateCalls).toEqual([{ fileId: "new-doc", addParents: "new-folder", fields: "id" }]);
  });

  test("defaults the folder/doc name to Shorthand Meeting Notes", async () => {
    const names: string[] = [];
    const driveFiles = {
      create: async (params: { requestBody: { name: string } }) => {
        names.push(params.requestBody.name);
        return { data: { id: "f1" } };
      },
      get: async () => ({ data: { parents: ["old-parent-id"] } }),
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
      get: async () => ({ data: { parents: ["old-parent-id"] } }),
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
      get: async (params: { fileId: string }) => {
        calls.push(`drive.get:${params.fileId}`);
        return { data: { parents: ["old-parent-id"] } };
      },
      update: async (params: { fileId: string; addParents: string; removeParents?: string }) => {
        calls.push(`drive.update:${params.fileId}:${params.addParents}:${params.removeParents}`);
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
    expect(result).toEqual({ folderId: "existing-folder", documentId: "new-doc", folderCreated: false, documentCreated: true });
    expect(calls).toEqual([
      "docs.create",
      "drive.get:new-doc",
      "drive.update:new-doc:existing-folder:old-parent-id",
    ]);
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
      get: async (params: { fileId: string }) => {
        calls.push(`drive.get:${params.fileId}`);
        return { data: { parents: ["users-own-existing-folder"] } };
      },
      update: async (params: { fileId: string; addParents: string; removeParents?: string }) => {
        calls.push(`drive.update:${params.fileId}:${params.addParents}:${params.removeParents}`);
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
    expect(result).toEqual({ folderId: "new-folder", documentId: "existing-doc", folderCreated: true, documentCreated: false });
    expect(calls).toEqual([
      "drive.create:application/vnd.google-apps.folder",
      "drive.get:existing-doc",
      "drive.update:existing-doc:new-folder:users-own-existing-folder",
    ]);
  });

  test("regression: on a failure after the folder was created, the thrown error names the folder id", async () => {
    const driveFiles = {
      create: async () => ({ data: { id: "orphan-folder-id" } }),
      get: async () => { throw new Error("Drive API unavailable"); },
      update: async () => { throw new Error("must not be called"); },
    };
    const docsDocuments = {
      create: async () => ({ data: { documentId: "new-doc" } }),
    };
    await expect(ensureContainerDoc(fakeAuth(), {}, { driveFiles, docsDocuments } as never)).rejects.toThrow(
      /orphan-folder-id/,
    );
  });

  test("does not decorate the error with a folder id when no folder was created by this call", async () => {
    const driveFiles = {
      create: async () => { throw new Error("must not create a folder when one already exists"); },
      get: async () => { throw new Error("Drive API unavailable"); },
      update: async () => { throw new Error("must not be called"); },
    };
    const docsDocuments = {
      create: async () => ({ data: { documentId: "new-doc" } }),
    };
    await expect(
      ensureContainerDoc(fakeAuth(), { folderId: "existing-folder" }, { driveFiles, docsDocuments } as never),
    ).rejects.toThrow("Drive API unavailable");
  });
});
