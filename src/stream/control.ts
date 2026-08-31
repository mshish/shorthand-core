import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { SpawnFn } from "./client.js";

/**
 * Send control signals to a running Shorthand instance.
 *
 * Shorthand exposes control only as CLI flags delivered through
 * `tauri_plugin_single_instance`: a second `shorthand` process detects the running app,
 * forwards its args, and exits.
 *
 * `start-assisted-notes`/`stop-assisted-notes` are the explicit pair for an Assisted
 * Notes capture, and are idempotent rather than toggle semantics: starting when a
 * capture is already running, or stopping when none is, is a success no-op instead of
 * flipping something. A toggle is ambiguous exactly when a caller needs to retry it —
 * if the confirmation for a first attempt is lost (a timeout that does not distinguish
 * "never arrived" from "arrived but the reply did not"), resending a *toggle* risks
 * firing the opposite edge from the one intended, undoing the very command the retry
 * was meant to repeat. The explicit pair removes that risk: sending `start` twice, or
 * `stop` twice, always converges on the same state, so a caller can retry freely.
 * `toggle-assisted-notes` still exists — fork-only and harmless for manual, interactive
 * use, where a human notices and corrects a wrong flip immediately — but a programmatic
 * caller (this library's own `StreamClient`-driven callers included) should prefer the
 * explicit pair.
 *
 * Control must be its own short-lived spawn, never an extra argument on the follower.
 * Shorthand's parser makes `--toggle-transcription`, `--toggle-post-process`, `--cancel`,
 * `--toggle-assisted-notes`, `--start-assisted-notes`, `--stop-assisted-notes` and
 * `--follow-stream` a fully mutually-conflicting set: `--start-assisted-notes`,
 * `--stop-assisted-notes` and `--follow-stream` each declare `conflicts_with_all` naming
 * every one of the other six, and clap's conflict check is symmetric regardless of which
 * side declares it (verified against `explicit_assisted_notes_flags_conflict_with_every_other_remote_control_flag`
 * in the app's `cli.rs` test module, which parses `--toggle-transcription
 * --start-assisted-notes` and asserts the failure even though `toggle_transcription`'s own
 * attribute declares no `conflicts_with_all` at all). So any two of these seven flags
 * together in one invocation fail to parse, not just a combination with `--follow-stream`.
 *
 * `toggle-assisted-notes`, `start-assisted-notes` and `stop-assisted-notes` each select
 * an app-owned capture mode by name. They carry no settings values, deliberately: the
 * app's own settings pane has to remain the only description of how a running capture
 * behaves, so this surface stays a fixed list of mode selectors rather than an override
 * channel.
 */
export type ControlSignal =
  | "toggle-transcription"
  | "toggle-post-process"
  | "toggle-assisted-notes"
  | "start-assisted-notes"
  | "stop-assisted-notes"
  | "cancel";

export type ControlResult =
  | { status: "sent" }
  | { status: "not-running" }
  | { status: "error"; message: string };

export type ShorthandControlOptions = {
  command: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
};

/**
 * Generous, because the only cost of waiting is a slower error: measured warm forwards
 * land in 48-71ms, but a cold start (the Tauri binary paging in, an unsigned exe being
 * scanned) can take seconds, and this one timeout is shared by every `ControlSignal`.
 *
 * What a false `not-running` costs differs by signal, but it is never free. For the
 * three genuine toggles (`toggle-transcription`, `toggle-post-process`,
 * `toggle-assisted-notes`) it tells the caller nothing happened; a human who presses
 * again fires the toggle twice and the two presses cancel out. `cancel` is not a toggle
 * and does not share that hazard — it is one-way, and a second `cancel` with nothing
 * running is a no-op — but a false `not-running` still misreports whether the capture
 * the caller wanted stopped was actually stopped.
 * `start-assisted-notes`/`stop-assisted-notes`
 * do not have that specific failure mode — that idempotence is the whole reason they
 * exist, see the class doc comment above — but a false `not-running` for them is still
 * a wrong answer a caller may act on: it can conclude Shorthand is not running and stop
 * retrying, or launch its own instance, when the original command may have reached a
 * live one whose confirmation merely arrived after the timeout. Generosity costs the
 * same slower error either way, so the timeout stays one value for every signal; only
 * the shape of getting it wrong differs.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** A control child always has piped stderr; `#spawn()` enforces it. */
type ControlChild = ChildProcess & { stderr: Readable };

export class ShorthandControl {
  readonly #command: string;
  readonly #spawnFn: SpawnFn;
  readonly #timeoutMs: number;

  constructor(options: ShorthandControlOptions) {
    this.#command = options.command;
    this.#spawnFn = options.spawnFn ?? spawn;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Resolve on whichever comes first: the child exiting (forwarded, or failed), or
   * the timeout.
   *
   * The timeout is the only way to detect "Shorthand is not running". When no instance is
   * running, this process becomes the primary Tauri instance and launches the whole
   * Shorthand app instead of forwarding the flag — the flag is only read inside the
   * single-instance callback, never on the primary startup path — and that process
   * then never exits.
   *
   * That child is deliberately never killed: on the `not-running` path the spawn *is*
   * the Shorthand app starting, so killing it would shut down the app the user was trying
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
        // Shorthand itself, still logging to this pipe. Closing the read end would break
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
   * non-zero exit report Shorthand's own error text instead of a bare exit code.
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
    if (code === "ENOENT") return `Shorthand binary not found at ${command}`;
    return error.message;
  }
  return String(error);
}
