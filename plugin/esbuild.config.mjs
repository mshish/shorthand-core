import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pluginDirectory = dirname(fileURLToPath(import.meta.url));
const nodeBuiltins = [...new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))];

/**
 * Exported so the watch driver (scripts/dev-plugin.mjs) reuses the exact production options
 * rather than keeping a second copy that drifts. The import goes that direction on purpose:
 * `plugin/` is a package root in waiting and must never reach up into the repo's scripts.
 */
export const buildOptions = {
  entryPoints: [join(pluginDirectory, "main.ts")],
  outfile: join(pluginDirectory, "main.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: "inline",
  // The Claude Agent SDK is ESM. Bundled into CJS, esbuild shims `import.meta` as an
  // empty object, so the SDK's `createRequire(import.meta.url)` receives undefined and
  // the plugin throws on load. Point it at a real file URL derived from __filename.
  define: { "import.meta.url": "__handyImportMetaUrl" },
  banner: {
    js: "const __handyImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  external: ["obsidian", "node:*", ...nodeBuiltins],
  logLevel: "info",
};

// Build once when run directly; stay side-effect free when imported by the watch driver.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await build(buildOptions);
}
