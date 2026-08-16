import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { detectHandyExecutable } from "../src/config.js";

const binaryName = process.platform === "win32" ? "handy.exe" : "handy";

async function directoryWithHandy(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "handy-detect-"));
  const binary = join(directory, binaryName);
  await writeFile(binary, "");
  if (process.platform !== "win32") await chmod(binary, 0o755);
  return directory;
}

describe("detectHandyExecutable", () => {
  test("an explicit override always wins and is resolved to an absolute path", () => {
    const detected = detectHandyExecutable("./custom-handy", { PATH: "" });
    expect(detected).toBe(resolve("./custom-handy"));
  });

  test("HANDY_BIN is used when no override is supplied", () => {
    const detected = detectHandyExecutable(undefined, { HANDY_BIN: "/opt/handy", PATH: "" });
    expect(detected).toBe(resolve("/opt/handy"));
  });

  test("an override outranks HANDY_BIN", () => {
    const detected = detectHandyExecutable("/from/flag", { HANDY_BIN: "/from/env", PATH: "" });
    expect(detected).toBe(resolve("/from/flag"));
  });

  test("falls back to a PATH lookup so no machine-specific path is baked in", async () => {
    const directory = await directoryWithHandy();
    const detected = detectHandyExecutable(undefined, { PATH: `${directory}${delimiter}/nowhere` });
    expect(detected).toBe(join(directory, binaryName));
  });

  test("skips PATH entries that do not contain the binary", async () => {
    const empty = await mkdtemp(join(tmpdir(), "handy-empty-"));
    const directory = await directoryWithHandy();
    const detected = detectHandyExecutable(undefined, { PATH: `${empty}${delimiter}${directory}` });
    expect(detected).toBe(join(directory, binaryName));
  });

  test("returns the bare command name when nothing is found, so spawn reports a clear ENOENT", () => {
    const detected = detectHandyExecutable(undefined, { PATH: "" });
    expect(detected).toBe(binaryName);
  });

  test("an empty override is treated as absent rather than as a path", () => {
    expect(detectHandyExecutable("", { PATH: "" })).toBe(binaryName);
  });
});
