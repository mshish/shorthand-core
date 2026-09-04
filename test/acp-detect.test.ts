import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { detectCursorExecutable } from "../src/agent/acp-client.js";

const tempDirectories: string[] = [];

function createTempDir(prefix = "shorthand-acp-detect-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(dir);
  return dir;
}

function createFile(dir: string, relativePath: string): string {
  const fullPath = join(dir, relativePath);
  const parent = fullPath.slice(0, fullPath.lastIndexOf(process.platform === "win32" ? "\\" : "/"));
  mkdirSync(parent, { recursive: true });
  writeFileSync(fullPath, "");
  return fullPath;
}

afterAll(() => {
  for (const dir of tempDirectories.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

describe("detectCursorExecutable", () => {
  describe("override and environment variables", () => {
    it("honours an explicit override", () => {
      const explicit = "D:\\custom\\agent.exe";
      expect(detectCursorExecutable(explicit)).toBe(resolve(explicit));
    });

    it("explicit override takes precedence over environment variables", () => {
      const explicit = "D:\\custom\\agent.exe";
      const env = {
        SHORTHAND_CURSOR_EXE: "C:\\bin\\cursor.cmd",
        SHORTHAND_ACP_EXE: "C:\\bin\\acp.cmd",
      };
      expect(detectCursorExecutable(explicit, env)).toBe(resolve(explicit));
    });

    it("honours SHORTHAND_CURSOR_EXE from environment", () => {
      const env = { SHORTHAND_CURSOR_EXE: "C:\\bin\\agent.cmd" };
      expect(detectCursorExecutable(undefined, env)).toBe(resolve("C:\\bin\\agent.cmd"));
    });

    it("honours SHORTHAND_ACP_EXE as a fallback environment variable", () => {
      const env = { SHORTHAND_ACP_EXE: "C:\\bin\\acp-agent.exe" };
      expect(detectCursorExecutable(undefined, env)).toBe(resolve("C:\\bin\\acp-agent.exe"));
    });

    it("SHORTHAND_CURSOR_EXE takes precedence over SHORTHAND_ACP_EXE", () => {
      const env = {
        SHORTHAND_CURSOR_EXE: "C:\\bin\\cursor-agent.cmd",
        SHORTHAND_ACP_EXE: "C:\\bin\\acp-agent.exe",
      };
      expect(detectCursorExecutable(undefined, env)).toBe(resolve("C:\\bin\\cursor-agent.cmd"));
    });

    it("ignores empty string overrides and falls back to environment or detection", () => {
      const env = { SHORTHAND_CURSOR_EXE: "C:\\bin\\agent.cmd" };
      expect(detectCursorExecutable("", env)).toBe(resolve("C:\\bin\\agent.cmd"));
    });

    it("ignores empty string SHORTHAND_CURSOR_EXE and falls back to SHORTHAND_ACP_EXE", () => {
      const env = {
        SHORTHAND_CURSOR_EXE: "",
        SHORTHAND_ACP_EXE: "C:\\bin\\acp.exe",
      };
      expect(detectCursorExecutable(undefined, env)).toBe(resolve("C:\\bin\\acp.exe"));
    });
  });

  describe("Windows platform lookups", () => {
    it("finds agent.cmd on PATH", () => {
      const binDir = createTempDir();
      createFile(binDir, "agent.cmd");
      const emptyDir = createTempDir();
      const env = {
        PATH: binDir,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(binDir, "agent.cmd")));
    });

    it("finds agent.ps1 on PATH", () => {
      const binDir = createTempDir();
      createFile(binDir, "agent.ps1");
      const emptyDir = createTempDir();
      const env = {
        PATH: binDir,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(binDir, "agent.ps1")));
    });

    it("finds cursor.cmd on PATH", () => {
      const binDir = createTempDir();
      createFile(binDir, "cursor.cmd");
      const emptyDir = createTempDir();
      const env = {
        PATH: binDir,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(binDir, "cursor.cmd")));
    });

    it("finds cursor.exe on PATH", () => {
      const binDir = createTempDir();
      createFile(binDir, "cursor.exe");
      const emptyDir = createTempDir();
      const env = {
        PATH: binDir,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(binDir, "cursor.exe")));
    });

    it("respects PATH order across directories for same binary name", () => {
      const dir1 = createTempDir();
      const dir2 = createTempDir();
      createFile(dir1, "agent.cmd");
      createFile(dir2, "agent.cmd");
      const emptyDir = createTempDir();
      const env = {
        PATH: `${dir1};${dir2}`,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(dir1, "agent.cmd")));
    });

    it("prefers agent executables over cursor editor wrapper across PATH directories", () => {
      const dir1 = createTempDir();
      const dir2 = createTempDir();
      createFile(dir1, "cursor.cmd");
      createFile(dir2, "agent.cmd");
      const emptyDir = createTempDir();
      const env = {
        PATH: `${dir1};${dir2}`,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(dir2, "agent.cmd")));
    });

    it("respects candidate preference within a single directory (agent.cmd before cursor.cmd)", () => {
      const binDir = createTempDir();
      createFile(binDir, "agent.cmd");
      createFile(binDir, "cursor.cmd");
      const emptyDir = createTempDir();
      const env = {
        PATH: binDir,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(binDir, "agent.cmd")));
    });

    it("reads Path variable case-insensitively on Windows", () => {
      const binDir = createTempDir();
      createFile(binDir, "agent.cmd");
      const emptyDir = createTempDir();
      const env = {
        Path: binDir,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(binDir, "agent.cmd")));
    });

    it("finds Cursor at LOCALAPPDATA Programs cursor path when PATH misses", () => {
      const appDataDir = createTempDir();
      const cursorCmd = createFile(appDataDir, join("Programs", "cursor", "resources", "app", "bin", "cursor.cmd"));
      const emptyDir = createTempDir();
      const env = {
        PATH: emptyDir,
        LOCALAPPDATA: appDataDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(cursorCmd));
    });

    it("finds Cursor at LOCALAPPDATA cursor-agent agent.ps1 when PATH misses", () => {
      const appDataDir = createTempDir();
      const agentPs1 = createFile(appDataDir, join("cursor-agent", "agent.ps1"));
      const emptyDir = createTempDir();
      const env = {
        PATH: emptyDir,
        LOCALAPPDATA: appDataDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(agentPs1));
    });

    it("prefers PATH executable over LOCALAPPDATA install", () => {
      const binDir = createTempDir();
      createFile(binDir, "agent.cmd");
      const appDataDir = createTempDir();
      createFile(appDataDir, join("Programs", "cursor", "resources", "app", "bin", "cursor.cmd"));
      const env = {
        PATH: binDir,
        LOCALAPPDATA: appDataDir,
        USERPROFILE: appDataDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBe(resolve(join(binDir, "agent.cmd")));
    });
  });

  describe("POSIX platform lookups (macOS/Linux)", () => {
    it("finds agent on PATH", () => {
      const binDir = createTempDir();
      createFile(binDir, "agent");
      const emptyDir = createTempDir();
      const env = {
        PATH: binDir,
        HOME: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "linux")).toBe(resolve(join(binDir, "agent")));
    });

    it("finds cursor on PATH", () => {
      const binDir = createTempDir();
      createFile(binDir, "cursor");
      const emptyDir = createTempDir();
      const env = {
        PATH: binDir,
        HOME: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "linux")).toBe(resolve(join(binDir, "cursor")));
    });

    it("respects candidate preference (agent before cursor) in PATH directory", () => {
      const binDir = createTempDir();
      createFile(binDir, "agent");
      createFile(binDir, "cursor");
      const emptyDir = createTempDir();
      const env = {
        PATH: binDir,
        HOME: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "linux")).toBe(resolve(join(binDir, "agent")));
    });

    it("finds agent in ~/.local/bin/agent via HOME when PATH misses", () => {
      const homeDir = createTempDir();
      const agentFile = createFile(homeDir, join(".local", "bin", "agent"));
      const emptyDir = createTempDir();
      const env = {
        PATH: emptyDir,
        HOME: homeDir,
      };
      expect(detectCursorExecutable(undefined, env, "linux")).toBe(resolve(agentFile));
    });

    it("prefers PATH executable over ~/.local/bin fallback", () => {
      const binDir = createTempDir();
      createFile(binDir, "cursor");
      const homeDir = createTempDir();
      createFile(homeDir, join(".local", "bin", "agent"));
      const env = {
        PATH: binDir,
        HOME: homeDir,
      };
      expect(detectCursorExecutable(undefined, env, "linux")).toBe(resolve(join(binDir, "cursor")));
    });
  });

  describe("not found fallback", () => {
    it("returns undefined when nothing is found on Windows", () => {
      const emptyDir = createTempDir();
      const env = {
        PATH: emptyDir,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "win32")).toBeUndefined();
    });

    it("returns undefined when nothing is found on POSIX", () => {
      const emptyDir = createTempDir();
      const env = {
        PATH: emptyDir,
        HOME: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env, "linux")).toBeUndefined();
    });

    it("uses process.platform by default when platform is omitted", () => {
      const emptyDir = createTempDir();
      const env = {
        PATH: emptyDir,
        LOCALAPPDATA: emptyDir,
        USERPROFILE: emptyDir,
        HOME: emptyDir,
      };
      expect(detectCursorExecutable(undefined, env)).toBeUndefined();
    });

    it("finds executable on default platform when platform argument is omitted", () => {
      const binDir = createTempDir();
      const emptyDir = createTempDir();
      if (process.platform === "win32") {
        createFile(binDir, "cursor.cmd");
        const env = {
          PATH: binDir,
          LOCALAPPDATA: emptyDir,
          USERPROFILE: emptyDir,
        };
        expect(detectCursorExecutable(undefined, env)).toBe(resolve(join(binDir, "cursor.cmd")));
      } else {
        createFile(binDir, "cursor");
        const env = {
          PATH: binDir,
          HOME: emptyDir,
        };
        expect(detectCursorExecutable(undefined, env)).toBe(resolve(join(binDir, "cursor")));
      }
    });
  });
});

