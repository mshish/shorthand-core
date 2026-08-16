import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * The `exports` map enforces the deep-import ban for bare specifiers only. A
 * RELATIVE specifier that escapes the importing file's own root
 * (`../../core/src/...`) bypasses bare-specifier resolution entirely, so tsc,
 * esbuild and node all resolve it happily and the boundary silently rots.
 *
 * Consumer directories are package roots in waiting: nothing inside one may
 * reach outside it except by package name.
 */
const CONSUMER_ROOTS = ["plugin"];
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["'](\.[^"']*)["']/g;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:ts|mts|js|mjs|cjs)$/.test(entry.name) && entry.name !== "main.js")
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("consumer source files never escape their own package root", () => {
  test.each(CONSUMER_ROOTS)("%s/ reaches core only by package name", async (consumer) => {
    const root = resolve(process.cwd(), consumer);
    const files = await sourceFiles(root);
    expect(files.length).toBeGreaterThan(0);
    const escapes: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const [, specifier] of source.matchAll(SPECIFIER)) {
        const target = resolve(file, "..", specifier!);
        const inside = relative(root, target);
        if (inside.startsWith("..")) escapes.push(`${relative(root, file)} -> ${specifier!}`);
      }
    }
    expect(escapes).toEqual([]);
  });
});
