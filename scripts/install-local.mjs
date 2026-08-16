#!/usr/bin/env node
// Copy the built plugin into a vault for local development.
//
// Deliberately a copy rather than a junction: this vault lives under OneDrive, and a junction
// inside a synced folder makes OneDrive follow it and churn on a 6.7 MB bundle every rebuild.
// A copy is boring, deterministic, and leaves nothing behind when you stop.
//
// This is the ADAPTED form of Obsidian's official dev loop. The docs tell you to develop
// *inside* `<vault>/.obsidian/plugins/<id>/` with a watch build writing straight there; that
// advice assumes the vault is an ordinary local folder. Here it is not, so the watch build
// stays in the repo and copies out. The observable end state — fresh main.js in the plugin
// directory, hot-reload picking it up — is identical.
//
// Target resolution, first match wins:
//   --vault <path>            explicit
//   HANDY_NOTES_VAULT         environment
// No default: a hardcoded path is the first thing that breaks on another machine.

import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "handy-notes";
const ASSETS = ["main.js", "manifest.json"];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(packageRoot, "plugin");

export function argumentValue(flag, args = process.argv.slice(2)) {
  const assigned = args.find((a) => a.startsWith(`${flag}=`));
  if (assigned !== undefined) return assigned.slice(flag.length + 1) || undefined;
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

export function resolveVault(args = process.argv.slice(2)) {
  return argumentValue("--vault", args) ?? process.env.HANDY_NOTES_VAULT;
}

/**
 * Copy plugin/main.js + plugin/manifest.json into `<vault>/.obsidian/plugins/handy-notes/`.
 * Returns `{ ok, target, size }` on success or `{ ok: false, code, message }` on failure, so
 * the esbuild watch loop can report a bad copy without killing the watcher.
 */
export async function installLocal(vault, { quiet = false } = {}) {
  if (!vault) {
    return {
      ok: false,
      code: 2,
      message:
        "No vault given. Pass --vault <path> or set HANDY_NOTES_VAULT.\n" +
        '  bun run install:local --vault "C:\\path\\to\\vault"',
    };
  }

  const vaultRoot = resolve(vault);
  try {
    if (!(await stat(join(vaultRoot, ".obsidian"))).isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      ok: false,
      code: 1,
      message: `${vaultRoot} does not look like an Obsidian vault (no .obsidian directory).`,
    };
  }

  for (const asset of ASSETS) {
    try {
      await stat(join(pluginDir, asset));
    } catch {
      return { ok: false, code: 1, message: `Missing plugin/${asset}. Run "bun run build:plugin" first.` };
    }
  }

  const target = join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID);
  await mkdir(target, { recursive: true });
  for (const asset of ASSETS) {
    // data.json is NOT copied: it is the user's saved settings and lives only in the vault.
    await copyFile(join(pluginDir, asset), join(target, asset));
  }

  // pjeby/hot-reload — the reloader the official development-workflow docs recommend — only
  // watches plugin directories that contain a `.git` subdirectory or a `.hotreload` file. We
  // copy in rather than cloning in, so there is no `.git` here and the marker is what enables
  // the loop. It never escapes: releases attach main.js + manifest.json explicitly, and
  // Obsidian only ever downloads main.js/manifest.json/styles.css.
  await writeFile(join(target, ".hotreload"), "");

  const { size } = await stat(join(target, "main.js"));
  if (!quiet) {
    console.log(`Installed ${ASSETS.join(" + ")} (${(size / 1_048_576).toFixed(1)} MB) into ${target}`);
    console.log("With the Hot Reload plugin enabled this reloads on its own; otherwise toggle the plugin off and on.");
  }
  return { ok: true, target, size };
}

// Only run the CLI when invoked directly — the esbuild watch build imports installLocal().
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await installLocal(resolveVault());
  if (!result.ok) console.error(result.message);
  process.exitCode = result.ok ? 0 : result.code;
}
