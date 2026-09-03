import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * Resolves the path to the Cursor CLI or an ACP-compatible agent executable.
 *
 * Precedence:
 * 1. Explicit `override` argument (if non-empty).
 * 2. `SHORTHAND_CURSOR_EXE` environment variable (if non-empty).
 * 3. `SHORTHAND_ACP_EXE` environment variable (if non-empty).
 * 4. PATH entries:
 *    - Windows: `agent.cmd`, `agent.ps1`, `cursor.cmd`, `cursor.exe`
 *    - POSIX: `agent`, `cursor`
 * 5. Conventional platform install locations:
 *    - Windows: `%LOCALAPPDATA%\Programs\cursor\resources\app\bin\cursor.cmd`,
 *               `%LOCALAPPDATA%\cursor-agent\agent.ps1`
 *    - POSIX: `~/.local/bin/agent`, `/usr/local/bin/agent`
 */
export function detectCursorExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const configured =
    override !== undefined && override.length > 0
      ? override
      : environment.SHORTHAND_CURSOR_EXE !== undefined && environment.SHORTHAND_CURSOR_EXE.length > 0
        ? environment.SHORTHAND_CURSOR_EXE
        : environment.SHORTHAND_ACP_EXE !== undefined && environment.SHORTHAND_ACP_EXE.length > 0
          ? environment.SHORTHAND_ACP_EXE
          : undefined;
  if (configured !== undefined) return resolve(configured);

  const searchPath =
    environment.PATH ??
    environment.Path ??
    Object.entries(environment).find(([k]) => k.toUpperCase() === "PATH")?.[1] ??
    "";
  const pathEntries = searchPath
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);

  const candidates: string[] = [];

  if (platform === "win32") {
    for (const dir of pathEntries) {
      candidates.push(
        join(dir, "agent.cmd"),
        join(dir, "agent.ps1"),
        join(dir, "cursor.cmd"),
        join(dir, "cursor.exe"),
      );
    }
    const localAppData = environment.LOCALAPPDATA ?? join(environment.USERPROFILE ?? homedir(), "AppData", "Local");
    candidates.push(
      join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
      join(localAppData, "cursor-agent", "agent.ps1"),
    );
  } else {
    for (const dir of pathEntries) {
      candidates.push(join(dir, "agent"), join(dir, "cursor"));
    }
    const home = environment.HOME ?? homedir();
    candidates.push(
      join(home, ".local", "bin", "agent"),
      "/usr/local/bin/agent",
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return undefined;
}
