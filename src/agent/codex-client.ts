import { resolve } from "node:path";

export function detectCodexExecutable(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = override ?? environment.SHORTHAND_CODEX_EXE;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  // No hardcoded install-path fallback: unlike detectClaudeExecutable's
  // ~/.local/bin/claude.exe check, Codex's own installer layout on Windows/macOS/Linux is
  // unverified here, and guessing one would be exactly the kind of unverified assumption
  // this project's own "do not assume, empirically test" principle rules out.
  // Leaving this undefined delegates PATH/platform auto-detection to the Codex SDK.
  return undefined;
}
