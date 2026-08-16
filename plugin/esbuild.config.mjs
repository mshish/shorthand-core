import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pluginDirectory = dirname(fileURLToPath(import.meta.url));
const nodeBuiltins = [...new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))];

await build({
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
});
