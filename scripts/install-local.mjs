#!/usr/bin/env node
// Copy the built plugin into a vault for local development.
//
// Deliberately a copy rather than a junction: this vault lives under OneDrive, and a junction
// inside a synced folder makes OneDrive follow it and churn on a 6.7 MB bundle every rebuild.
// A copy is boring, deterministic, and leaves nothing behind when you stop.
//
// Target resolution, first match wins:
//   --vault <path>            explicit
//   HANDY_NOTES_VAULT         environment
// No default: a hardcoded path is the first thing that breaks on another machine.

import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "handy-notes";
const ASSETS = ["main.js", "manifest.json"];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(packageRoot, "plugin");

function argumentValue(flag) {
  const args = process.argv.slice(2);
  const assigned = args.find((a) => a.startsWith(`${flag}=`));
  if (assigned !== undefined) return assigned.slice(flag.length + 1) || undefined;
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

async function main() {
  const vault = argumentValue("--vault") ?? process.env.HANDY_NOTES_VAULT;
  if (!vault) {
    console.error(
      "No vault given. Pass --vault <path> or set HANDY_NOTES_VAULT.\n" +
      "  bun run install:local --vault \"C:\\\\path\\\\to\\\\vault\"",
    );
    return 2;
  }

  const vaultRoot = resolve(vault);
  try {
    if (!(await stat(join(vaultRoot, ".obsidian"))).isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`${vaultRoot} does not look like an Obsidian vault (no .obsidian directory).`);
    return 1;
  }

  for (const asset of ASSETS) {
    try {
      await stat(join(pluginDir, asset));
    } catch {
      console.error(`Missing plugin/${asset}. Run "bun run build:plugin" first.`);
      return 1;
    }
  }

  const target = join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID);
  await mkdir(target, { recursive: true });
  for (const asset of ASSETS) {
    // data.json is NOT copied: it is the user's saved settings and lives only in the vault.
    await copyFile(join(pluginDir, asset), join(target, asset));
  }

  const { size } = await stat(join(target, "main.js"));
  console.log(`Installed ${ASSETS.join(" + ")} (${(size / 1_048_576).toFixed(1)} MB) into ${target}`);
  console.log("Reload Obsidian, or toggle the plugin off and on, to pick it up.");
  return 0;
}

process.exitCode = await main();
