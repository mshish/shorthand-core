import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Nothing else in CI ever LOADS the plugin bundle — it is built and then never
 * required. That is how the `import.meta.url` banner in plugin/esbuild.config.mjs
 * came to exist: the plugin failed at Obsidian load once, with every check green.
 * A barrel that drags a new module into the bundle graph reproduces exactly that
 * class of failure, so the entry point must be executed here.
 */
const BUNDLE = resolve(process.cwd(), "plugin", "main.js");

/**
 * Recorded after Phase B0's barrel landed. It is the canary: `export *` in an
 * entry point, or a stray import that pulls a second copy of the agent SDK in,
 * shows up here long before anyone notices a 40 MB download.
 */
const BASELINE_BYTES = 6_985_538;
const MAX_GROWTH = 1.2;

const OBSIDIAN_STUB = `
class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Modal { constructor(app) { this.app = app; } }
class Notice { constructor(message) { this.message = message; } }
class Setting { constructor(container) { this.container = container; } }
class MarkdownView {}
class FileSystemAdapter {}
module.exports = { Plugin, PluginSettingTab, Modal, Notice, Setting, MarkdownView, FileSystemAdapter };
`;

function ensureBundle(): void {
  if (existsSync(BUNDLE)) return;
  const built = spawnSync(process.execPath, [join("plugin", "esbuild.config.mjs")], { stdio: "inherit" });
  if (built.status !== 0) throw new Error("plugin/main.js is missing and `bun run build:plugin` failed.");
}

describe("the built plugin bundle", () => {
  test("loads under a stub obsidian and exports a Plugin class with onload/onunload", async () => {
    ensureBundle();
    const directory = await mkdtemp(join(tmpdir(), "handy-plugin-load-"));
    try {
      await mkdir(join(directory, "node_modules", "obsidian"), { recursive: true });
      await writeFile(
        join(directory, "node_modules", "obsidian", "package.json"),
        JSON.stringify({ name: "obsidian", version: "0.0.0", main: "index.js" }),
        "utf8",
      );
      await writeFile(join(directory, "node_modules", "obsidian", "index.js"), OBSIDIAN_STUB, "utf8");
      const copied = join(directory, "main.js");
      await copyFile(BUNDLE, copied);
      const loaded: Record<string, unknown> = createRequire(join(directory, "loader.cjs"))(copied);
      const exported = loaded.default;
      expect(typeof exported).toBe("function");
      const prototype = (exported as new () => unknown).prototype as Record<string, unknown>;
      expect(typeof prototype.onload).toBe("function");
      expect(typeof prototype.onunload).toBe("function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("has not grown more than 20% past its recorded baseline", async () => {
    ensureBundle();
    const { size } = await stat(BUNDLE);
    expect(size).toBeLessThanOrEqual(Math.round(BASELINE_BYTES * MAX_GROWTH));
    // A collapse is just as suspicious as bloat: it usually means the entry point
    // stopped pulling in the agent SDK and the plugin will fail at runtime instead.
    expect(size).toBeGreaterThan(BASELINE_BYTES / 2);
  });
});
