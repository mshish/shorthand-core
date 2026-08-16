#!/usr/bin/env node
// Bump the plugin version in the three places that must agree.
//
// Adapted from obsidianmd/obsidian-sample-plugin's version-bump.mjs. The sample's script is
// driven by `npm version`, which sets `npm_package_version` first and then runs the `version`
// lifecycle hook. This repo builds with Bun and has no package-lock.json, so the version is
// passed explicitly instead of read from the environment. Everything downstream — manifest,
// versions.json, tag == manifest equality — matches the official convention exactly.
//
//   bun run version:bump 0.2.0
//
// Then: commit, `git tag 0.2.0`, push the tag. The release workflow re-checks the tag against
// plugin/manifest.json and plugin/versions.json and fails the build on any drift.
//
// minAppVersion is NOT bumped here, deliberately: raising it is a compatibility decision, not a
// release chore. Edit plugin/manifest.json by hand first if a release needs a newer Obsidian,
// and this script will record that value against the new version in versions.json.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(packageRoot, "plugin", "manifest.json");
const versionsPath = join(packageRoot, "plugin", "versions.json");
const packagePath = join(packageRoot, "package.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// 2-space, trailing newline: matches Prettier's output for the rest of the repo. The sample
// writes tabs because the sample repo is tab-indented; the format is not load-bearing.
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const target = process.argv[2];
  if (target === undefined) {
    console.error('No version given. Usage: bun run version:bump 0.2.0');
    return 2;
  }
  if (!/^\d+\.\d+\.\d+$/.test(target)) {
    console.error(`"${target}" is not a semantic version in x.y.z form.`);
    console.error("Obsidian requires bare x.y.z — no leading v, no pre-release suffix.");
    return 2;
  }

  const manifest = readJson(manifestPath);
  const { minAppVersion } = manifest;
  if (typeof minAppVersion !== "string" || minAppVersion.length === 0) {
    console.error("plugin/manifest.json has no minAppVersion; versions.json cannot be written.");
    return 1;
  }

  manifest.version = target;
  writeJson(manifestPath, manifest);

  const versions = readJson(versionsPath);
  // Only add — never rewrite an existing entry. A published version's minAppVersion is a
  // historical fact that older Obsidian installs still resolve against.
  if (!(target in versions)) {
    versions[target] = minAppVersion;
    writeJson(versionsPath, versions);
  }

  // Kept in sync so the eventual workspace split starts from an honest version. The package is
  // private and unpublished, so nothing consumes this field today.
  const packageJson = readJson(packagePath);
  packageJson.version = target;
  writeJson(packagePath, packageJson);

  console.log(`Set version ${target} (minAppVersion ${minAppVersion}) in:`);
  console.log("  plugin/manifest.json");
  console.log("  plugin/versions.json");
  console.log("  package.json");
  console.log(`Next: git commit, then git tag ${target} && git push origin ${target}`);
  return 0;
}

process.exitCode = main();
