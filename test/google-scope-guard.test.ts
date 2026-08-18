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
});
