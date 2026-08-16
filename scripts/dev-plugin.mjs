#!/usr/bin/env node
// Watch build: rebuild plugin/main.js on every source change and reinstall it into a vault.
//
// This is the local form of Obsidian's official dev loop. The sample plugin's `dev` script is
// an esbuild `context().watch()`, and so is this — the one difference is where the output
// lands. The docs assume the repo IS `<vault>/.obsidian/plugins/<id>/` and let esbuild write
// straight there; that vault is OneDrive-synced here, so the build stays in the repo and the
// bundle is copied out (see install-local.mjs).
//
// Lives in scripts/, not plugin/, deliberately: plugin/ is a package root in waiting and may
// not import anything above itself. The dependency runs scripts/ -> plugin/, never back.
//
//   bun run dev:plugin --vault "C:\path\to\vault"     (or set HANDY_NOTES_VAULT)

import esbuild from "esbuild";
import { buildOptions } from "../plugin/esbuild.config.mjs";
import { installLocal, resolveVault } from "./install-local.mjs";

const vault = resolveVault();
if (!vault) {
  console.error("Watch mode needs a vault to install into.");
  console.error('  bun run dev:plugin --vault "C:\\path\\to\\vault"   (or set HANDY_NOTES_VAULT)');
  process.exit(2);
}

const context = await esbuild.context({
  ...buildOptions,
  plugins: [
    {
      name: "install-into-vault",
      setup(build) {
        // onEnd fires after every rebuild, failures included. Copying a stale bundle over a
        // broken build would silently hide the error, so bail on any error result.
        build.onEnd(async (result) => {
          if (result.errors.length > 0) return;
          const installed = await installLocal(vault, { quiet: true });
          console.log(
            installed.ok
              ? `[${new Date().toLocaleTimeString()}] installed ${(installed.size / 1_048_576).toFixed(1)} MB into ${installed.target}`
              : `[install failed] ${installed.message}`,
          );
        });
      },
    },
  ],
});

await context.watch();
console.log("Watching plugin/main.ts and its imports. Ctrl+C to stop.");
console.log("Install the Hot Reload plugin in this vault to skip the manual toggle after each rebuild.");
