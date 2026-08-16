import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { SpawnFn } from "./client.js";

/**
 * Send control signals to a running Handy instance.
 *
 * Handy exposes control only as CLI flags delivered through
 * `tauri_plugin_single_instance`: a second `handy` process detects the running app,
 * forwards its args, and exits. There is no `--start`/`--stop` — the transcription
 * flags are toggles.
 *
 * Control must be its own short-lived spawn, never an extra argument on the
 * follower: Handy's parser declares `--follow-stream` as
 * `conflicts_with_all = ["toggle_transcription", "toggle_post_process", "cancel"]`,
 * so a combined invocation fails to parse.
 */
export type ControlSignal = "toggle-transcription" | "toggle-post-process" | "cancel";

export type ControlResult =
  | { status: "sent" }
  | { status: "not-running" }
  | { status: "error"; message: string };

export type HandyControlOptions = {
  command: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
};

/**
 * Generous, because the only cost of waiting is a slower error and the only cost of
 * being wrong is the worst one available: measured warm forwards land in 48-71ms, but
 * a cold start (the Tauri binary paging in, an unsigned exe being scanned) can take
 * seconds, and a false `not-running` on a *toggle* tells the user nothing happened —
 * they press again and the two toggles cancel out.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** A control child always has piped stderr; `#spawn()` enforces it. */
type ControlChild = ChildProcess & { stderr: Readable };

export class HandyControl {
  readonly #command: string;
  readonly #spawnFn: SpawnFn;
  readonly #timeoutMs: number;

  constructor(options: HandyControlOptions) {
    this.#command = options.command;
    this.#spawnFn = options.spawnFn ?? spawn;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Resolve on whichever comes first: the child exiting (forwarded, or failed), or
   * the timeout.
   *
   * The timeout is the only way to detect "Handy is not running". When no instance is
   * running, this process becomes the primary Tauri instance and launches the whole
   * Handy app instead of forwarding the flag — the flag is only read inside the
   * single-instance callback, never on the primary startup path — and that process
   * then never exits.
   *
   * That child is deliberately never killed: on the `not-running` path the spawn *is*
   * the Handy app starting, so killing it would shut down the app the user was trying
   * to reach. It therefore outlives the call, which is why `#spawn()` goes out of its
   * way to make an abandoned child unable to hold the host alive, and why settling
   * detaches this call's stderr bookkeeping instead of leaving it accumulating for the
   * rest of the session.
   */
  send(signal: ControlSignal): Promise<ControlResult> {
    return new Promise<ControlResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let release = (): void => {};
      const settle = (result: ControlResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        release();
        resolve(result);
      };

      let child: ControlChild;
      try {
        child = this.#spawn(signal);
      } catch (error) {
        settle({ status: "error", message: describe(error, this.#command) });
        return;
      }

      let stderr = "";
      const collect = (chunk: Buffer): void => { stderr += chunk.toString("utf8"); };
      child.stderr.on("data", collect);
      release = () => {
        child.stderr.off("data", collect);
        stderr = "";
        // Keep draining and discarding rather than destroying: an abandoned child is
        // Handy itself, still logging to this pipe. Closing the read end would break
        // its stderr writes; leaving it paused would eventually block them on a full
        // OS pipe buffer.
        child.stderr.resume();
      };
      child.on("error", (error: Error) => {
        settle({ status: "error", message: describe(error, this.#command) });
      });
      child.on("close", (code) => {
        if (code === 0) {
          settle({ status: "sent" });
          return;
        }
        settle({
          status: "error",
          message: stderr.trim() || `${this.#command} --${signal} exited with code ${String(code)}`,
        });
      });

      timer = setTimeout(() => {
        timer = null;
        settle({ status: "not-running" });
      }, this.#timeoutMs);
    });
  }

  /**
   * Fire-and-forget variant for teardown paths, where nothing is left to await the
   * result. Failures are swallowed, but the `error` listener is mandatory: without
   * it an ENOENT from the spawn becomes an unhandled process-level error event.
   */
  sendDetached(signal: ControlSignal): void {
    try {
      const child = this.#spawn(signal);
      child.on("error", () => {});
      // Nobody is left to read it, but the pipe must still be drained or a child that
      // outlives us blocks on a full stderr buffer.
      child.stderr.resume();
    } catch {
      // Teardown has nowhere to report to; a failed toggle must not break shutdown.
    }
  }

  /**
   * Like `StreamClient.#spawn()` — detached and `unref()`ed — but with one extra step
   * that matters more here, because a control child is routinely abandoned rather than
   * killed: `child.unref()` unrefs only the *process* handle, while `stdio[2]: "pipe"`
   * also creates a ref'd libuv pipe handle that keeps the host's event loop alive by
   * itself. Measured against a never-exiting child: with `child.unref()` alone the host
   * was still running 5s after `send()` settled; adding `stderr.unref()` let it exit
   * ~2ms later. stderr stays piped rather than "ignore" because it is what makes a
   * non-zero exit report Handy's own error text instead of a bare exit code.
   */
  #spawn(signal: ControlSignal): ControlChild {
    const child = this.#spawnFn(this.#command, [`--${signal}`], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: true,
    });
    if (child.stderr === null) {
      throw new Error("control child must expose piped stderr");
    }
    child.unref();
    unrefStream(child.stderr);
    return child as ControlChild;
  }
}

/**
 * Child stdio pipes are `net.Socket`s, whose `unref()` is not on the `Readable` type
 * the `ChildProcess` declaration exposes — and is absent altogether on the plain
 * streams tests substitute.
 */
function unrefStream(stream: Readable): void {
  (stream as Readable & { unref?: () => void }).unref?.();
}

function describe(error: unknown, command: string): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `Handy binary not found at ${command}`;
    return error.message;
  }
  return String(error);
}
