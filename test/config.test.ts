import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { detectShorthandExecutable, shorthandConfigDirectory } from "../src/config.js";

const binaryName = process.platform === "win32" ? "shorthand.exe" : "shorthand";

async function directoryWithShorthand(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "shorthand-detect-"));
  const binary = join(directory, binaryName);
  await writeFile(binary, "");
  if (process.platform !== "win32") await chmod(binary, 0o755);
  return directory;
}

describe("detectShorthandExecutable", () => {
  test("an explicit override always wins and is resolved to an absolute path", () => {
    const detected = detectShorthandExecutable("./custom-shorthand", { PATH: "" });
    expect(detected).toBe(resolve("./custom-shorthand"));
  });

  test("SHORTHAND_BIN is used when no override is supplied", () => {
    const detected = detectShorthandExecutable(undefined, { SHORTHAND_BIN: "/opt/shorthand", PATH: "" });
    expect(detected).toBe(resolve("/opt/shorthand"));
  });

  test("an override outranks SHORTHAND_BIN", () => {
    const detected = detectShorthandExecutable("/from/flag", { SHORTHAND_BIN: "/from/env", PATH: "" });
    expect(detected).toBe(resolve("/from/flag"));
  });

  test("falls back to a PATH lookup so no machine-specific path is baked in", async () => {
    const directory = await directoryWithShorthand();
    const detected = detectShorthandExecutable(undefined, { PATH: `${directory}${delimiter}/nowhere` });
    expect(detected).toBe(join(directory, binaryName));
  });

  test("skips PATH entries that do not contain the binary", async () => {
    const empty = await mkdtemp(join(tmpdir(), "shorthand-empty-"));
    const directory = await directoryWithShorthand();
    const detected = detectShorthandExecutable(undefined, { PATH: `${empty}${delimiter}${directory}` });
    expect(detected).toBe(join(directory, binaryName));
  });

  test("returns the bare command name when nothing is found, so spawn reports a clear ENOENT", () => {
    const detected = detectShorthandExecutable(undefined, { PATH: "" });
    expect(detected).toBe(binaryName);
  });

  test("an empty override is treated as absent rather than as a path", () => {
    expect(detectShorthandExecutable("", { PATH: "" })).toBe(binaryName);
  });
});

describe("shorthandConfigDirectory", () => {
  test("uses APPDATA on Windows", () => {
    if (process.platform !== "win32") return;
    expect(shorthandConfigDirectory({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }))
      .toBe(join("C:\\Users\\me\\AppData\\Roaming", "Shorthand"));
  });

  test("uses Library/Application Support on macOS", () => {
    if (process.platform !== "darwin") return;
    expect(shorthandConfigDirectory({ HOME: "/Users/me" }))
      .toBe(join("/Users/me", "Library", "Application Support", "Shorthand"));
  });

  test("uses XDG_CONFIG_HOME when set on Linux", () => {
    if (process.platform === "win32" || process.platform === "darwin") return;
    expect(shorthandConfigDirectory({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" }))
      .toBe(join("/xdg", "shorthand"));
  });

  test("falls back to ~/.config on Linux when XDG_CONFIG_HOME is unset", () => {
    if (process.platform === "win32" || process.platform === "darwin") return;
    expect(shorthandConfigDirectory({ HOME: "/home/me" }))
      .toBe(join("/home/me", ".config", "shorthand"));
  });

  test("falls back to os.homedir() when neither USERPROFILE nor HOME is set", () => {
    const detected = shorthandConfigDirectory({});
    expect(detected.startsWith(homedir()) || detected.includes(homedir())).toBe(true);
  });
});
