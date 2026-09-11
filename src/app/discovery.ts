import { readFile } from "node:fs/promises";
import { requestSocketDiscoveryPath } from "../config.js";

/**
 * Where the Shorthand app is listening, as the app itself wrote it: the protocol it
 * speaks and the socket address to connect to.
 */
export type RequestSocketDiscovery = Readonly<{ protocol: number; path: string }>;

/**
 * Reads the discovery file the app writes when it starts listening. NEVER throws.
 *
 * The writer is the app — a different program in a different language — and the file is
 * removed on a clean stop, so "absent" and "half-written" are both ordinary states rather
 * than bugs here. Every failure collapses to `undefined` so the one caller
 * (`ShorthandAppClient.connect`) can report the single thing a user can act on: the app
 * is not running. Distinguishing "no file" from "corrupt file" would offer a choice
 * neither the caller nor the user has.
 */
export async function readDiscovery(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RequestSocketDiscovery | undefined> {
  let text: string;
  try {
    text = await readFile(requestSocketDiscoveryPath(environment), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const { protocol, path } = parsed as { protocol?: unknown; path?: unknown };
  if (typeof protocol !== "number" || !Number.isSafeInteger(protocol)) return undefined;
  if (typeof path !== "string" || path.length === 0) return undefined;
  return { protocol, path };
}
