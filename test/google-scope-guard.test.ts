import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function allSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return allSourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat();
}

describe("Google OAuth scope guard", () => {
  test("no source file requests a googleapis.com/auth/ scope other than drive.file", async () => {
    const files = [...await allSourceFiles("src"), ...await allSourceFiles("bin")];
    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const matches = content.match(/googleapis\.com\/auth\/[\w.]+/g) ?? [];
      for (const match of matches) {
        if (match !== "googleapis.com/auth/drive.file") offenders.push(`${file}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the drive.file scope is still actually present, anchored on the sink that uses it", async () => {
    // The negative test above is satisfied by an empty match set, so on its own it
    // cannot tell "correctly scoped" from "the scope code left the building". Core no
    // longer REQUESTS this scope — whatever performs consent builds the authorization
    // URL — so the only thing anchoring this guard to reality is the constant the sink
    // authenticates with. Anchor on that file by name: a match found anywhere else is
    // not evidence the sink still declares its scope.
    const anchor = join("src", "google", "docs-sink.ts");
    const anchored = (await readFile(anchor, "utf8")).match(/googleapis\.com\/auth\/[\w.]+/g) ?? [];
    expect(anchored).toEqual(["googleapis.com/auth/drive.file"]);

    const files = [...await allSourceFiles("src"), ...await allSourceFiles("bin")];
    const all = (await Promise.all(files.map(async (file) => (
      (await readFile(file, "utf8")).match(/googleapis\.com\/auth\/[\w.]+/g) ?? []
    )))).flat();
    expect(all.length).toBeGreaterThan(0);
  });
});
