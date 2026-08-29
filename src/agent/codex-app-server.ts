import { spawn, type ChildProcess } from "node:child_process";
import {
  AgentCatalogError,
  CATALOG_TIMEOUT_MS,
  type AgentCatalog,
  type AgentModel,
  type CatalogFailureReason,
} from "./catalog.js";
import { detectCodexExecutable } from "./codex-client.js";
import { Utf8LineReader } from "../ndjson.js";
// The only import `agent/` takes from `stream/`, and deliberately a type-only one: it erases at
// compile time, so no transcript-stream code is pulled into a catalog fetch at runtime. Both
// seams are the signature of `node:child_process`'s own `spawn`, so this is one shape with one
// name rather than two that drift apart. If `stream/`'s seam ever needs to change for reasons
// that have nothing to do with this module, move the type to a neutral module instead of
// copying it back — two near-identical spawn seams is the outcome worth avoiding here.
import type { SpawnFn } from "../stream/client.js";

/**
 * Reads Codex's model catalog by speaking `codex app-server`'s JSON-RPC over stdio, rather than
 * through `@openai/codex-sdk` — the SDK shells `codex exec` and has no app-server transport, so
 * this is new wire protocol, not a reuse of `CodexAgentClient`. `model/list` is documented at
 * https://learn.chatgpt.com/docs/app-server and is stable (it appears in
 * `codex app-server generate-json-schema` without `--experimental`), verified against
 * codex-cli 0.150.1.
 *
 * The client below exists to run exactly one fixed sequence
 * (`initialize` -> `initialized` -> `model/list`[+pagination] / `account/read`) against a
 * short-lived child, once, and then kill it. It is deliberately not a general JSON-RPC or
 * app-server SDK: there is no subscription API, no support for methods nothing here calls, and
 * no request registry beyond what that one sequence needs.
 */

/** One entry of `model/list`'s `data` array. Fields nothing here reads (upgrade info, service
 * tiers, input modalities, ...) are left off on purpose — adding one back the day a caller
 * needs it is free, and carrying it unused is not free: it is one more field a future change
 * has to remember still matches the wire shape. */
export type CodexCatalogModel = Readonly<{
  id: string;
  displayName: string;
  description: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  /**
   * Per-model, not a shared union: `gpt-5.4` stops at `xhigh` while `gpt-5.6-sol` goes on to
   * `max` and `ultra`. Each entry is an object with its own `description`, which this module
   * does not keep — `AgentModel.efforts` wants the bare `reasoningEffort` strings only.
   */
  supportedReasoningEfforts?: readonly Readonly<{ reasoningEffort: string; description: string }>[];
}>;

type CodexModelListResult = Readonly<{ data: readonly CodexCatalogModel[]; nextCursor: string | null }>;

/** `account/read`'s result. `account` is `null` when signed out — never an error, see
 * `toCodexCatalog`'s doc comment for why that matters. */
export type CodexAccountReadResult = Readonly<{ account: Readonly<{ email?: string }> | null }>;

export type ListCodexModelsOptions = Readonly<{
  /** Same override precedence as {@link detectCodexExecutable}. */
  codexPathOverride?: string;
  /** Defaults to `process.env`. Deliberately the AMBIENT environment, never an isolated one —
   * see the comment on the spawn call in {@link listCodexModels} for why. */
  environment?: NodeJS.ProcessEnv;
  /** Defaults to {@link CATALOG_TIMEOUT_MS}. Overridable so a test can exercise the timeout
   * path in milliseconds instead of waiting out the real 20s production budget. */
  timeoutMs?: number;
  /** Test-only seam: overrides how the `app-server` child is spawned. Production never sets
   * this and gets Node's real `spawn`; a test points it at a fixture script that speaks the
   * protocol instead of a real `codex` binary, without touching the handshake logic that talks
   * to whatever process comes back. */
  spawnFn?: SpawnFn;
}>;

/**
 * The one Codex spawn that deliberately reads the operator's ambient `CODEX_HOME` instead of the
 * isolated one `CodexAgentClient` builds for enhancement passes — see
 * docs/AGENT-SESSION-PRIVACY.md § "Reading the model catalog". The catalog is account-scoped: an
 * isolated home has no `auth.json`, so probing it would answer a different question (the
 * signed-out list) than the one the caller asked, for a caller who may well be signed in. No
 * transcript, section, or vault path reaches this probe — it starts no thread, sends no prompt,
 * and asks only `model/list` and `account/read` before killing the child.
 */
export async function listCodexModels(options: ListCodexModelsOptions = {}): Promise<AgentCatalog> {
  const environment = options.environment ?? process.env;
  const executable = detectCodexExecutable(options.codexPathOverride, environment);
  if (executable === undefined) {
    throw new AgentCatalogError(
      "executable-not-found",
      "Could not locate a codex executable to run `codex app-server`.",
    );
  }
  const spawnFn = options.spawnFn ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnFn(executable, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: environment, windowsHide: true });
  } catch (error) {
    throw classifyCodexCatalogFailure(error);
  }

  // Drained unconditionally, whether or not a failure ends up mentioning it: an app-server that
  // logs enough during startup fills the OS pipe buffer and blocks on write once nothing reads
  // stdout — with stderr as the culprit, that surfaced as a bare `timeout` with no diagnostic
  // text. The captured text is folded into whichever failure actually happens below.
  const stderrCapture: StderrCapture = { text: "" };
  child.stderr?.on("data", (chunk: Buffer) => { stderrCapture.text += chunk.toString("utf8"); });

  const handshake = runAppServerHandshake(child, stderrCapture);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AgentCatalogError(
        "timeout",
        withStderr(`Codex model catalog fetch exceeded ${timeoutMs}ms.`, stderrCapture.text),
      )),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([handshake, timeout]);
  } catch (error) {
    throw classifyCodexCatalogFailure(error, stderrCapture.text);
  } finally {
    clearTimeout(timer);
    // Always killed, on every path: a resolved handshake still leaves the app-server sitting on
    // stdio with nothing left to ask it, and a timeout or protocol error must not leak the
    // child either — a leaked `codex app-server` is a real process, not just an unread promise.
    //
    // This kills only the immediate child, not a process tree. Deliberate for now: the measured
    // round trip for the real handshake is ~585ms (see CATALOG_TIMEOUT_MS's doc comment), which
    // is circumstantial evidence that `codex app-server` does not eagerly spawn MCP server
    // grandchildren just to answer `model/list`/`account/read` — those would plausibly add
    // observable startup latency of their own. If a future `codex` version starts spawning
    // children during this exact handshake (not just when a tool call actually needs one), a
    // leaked grandchild would follow, and killing the tree (e.g. `taskkill /t` on Windows,
    // process-group kill elsewhere) would need to replace this.
    if (child.exitCode === null && child.signalCode === null) child.kill();
    // If the timeout above won the race, `handshake` is still running and will reject once the
    // kill fires its own close handler below — nothing is awaiting it by then, but Node still
    // reports that as an unhandled rejection unless something reads it.
    handshake.catch(() => {});
  }
}

/** Accumulates a child's stderr so a failure can name what it logged. A plain mutable object
 * rather than a closure variable so `listCodexModels` (which owns the timeout race) and
 * `runAppServerHandshake` (which owns the child's own close/error handlers) can both read the
 * latest text without one having to call back into the other. */
type StderrCapture = { text: string };

function withStderr(message: string, stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length === 0 ? message : `${message} stderr: ${trimmed}`;
}

/**
 * Runs the fixed handshake over the child's stdio and resolves once both `model/list` (with any
 * pagination) and `account/read` have answered. Responses are matched strictly by `id`: the
 * server interleaves unsolicited notifications (`remoteControl/status/changed` and similar) with
 * responses, and does not guarantee response order matches request order, so anything without a
 * numeric `id` is ignored and nothing here assumes id 2 arrives before id 3.
 */
function runAppServerHandshake(child: ChildProcess, stderrCapture: StderrCapture): Promise<AgentCatalog> {
  return new Promise<AgentCatalog>((resolveHandshake, rejectHandshake) => {
    if (child.stdout === null || child.stdin === null) {
      rejectHandshake(new AgentCatalogError("spawn-failed", "codex app-server child has no piped stdio."));
      return;
    }
    const stdout = child.stdout;
    const stdin = child.stdin;

    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectHandshake(error);
    };
    const succeed = (catalog: AgentCatalog): void => {
      if (settled) return;
      settled = true;
      resolveHandshake(catalog);
    };

    // ENOENT can arrive here asynchronously rather than as a throw from spawnFn (platform
    // dependent), and an app-server that dies mid-handshake never rejects on its own — both
    // would otherwise leave this promise pending forever instead of failing.
    child.once("error", (error) => fail(classifyCodexCatalogFailure(error, stderrCapture.text)));
    child.once("close", (code) => {
      fail(new AgentCatalogError(
        "spawn-failed",
        withStderr(
          `codex app-server exited (code ${String(code)}) before the catalog handshake completed.`,
          stderrCapture.text,
        ),
      ));
    });

    let nextId = 1;
    const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: unknown) => void }>();

    const write = (message: Record<string, unknown>): void => {
      stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: unknown = {}): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        write({ jsonrpc: "2.0", id, method, params });
      });
    };
    const notify = (method: string): void => write({ jsonrpc: "2.0", method });

    // Byte-and-line framing is Utf8LineReader's job (shared with stream/client.ts's
    // NdjsonDecoder — see its doc comment), so this only has to turn one complete line into a
    // JSON-RPC message. `onLine` runs synchronously inside `lineReader.push`, so wrapping the
    // `data` listener's body in try/catch below catches anything thrown from in here too.
    const lineReader = new Utf8LineReader((rawLine) => {
      const line = rawLine.trim();
      if (line.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail(new AgentCatalogError(
          "protocol",
          `codex app-server sent a line that is not valid JSON: ${line}`,
          { cause: error },
        ));
        return;
      }
      // A JSON-RPC message is always an object; a bare number, string, array, or `null` line
      // would otherwise reach `"id" in parsed` below and throw `TypeError` synchronously inside
      // this stdout listener — see the `data` handler's own comment for what that costs.
      if (!isRecord(parsed)) {
        fail(new AgentCatalogError(
          "protocol",
          `codex app-server sent a JSON-RPC message that is not an object: ${line}`,
        ));
        return;
      }
      // Notifications, and responses to ids this handshake never sent, both lack a tracked
      // waiter — ignored the same way, matching strictly on id rather than shape or method.
      if (typeof parsed.id !== "number") return;
      const waiter = pending.get(parsed.id);
      if (waiter === undefined) return;
      pending.delete(parsed.id);
      // `error` is JSON-RPC's own field name for "this call failed" — `null` is how a server
      // that always emits the key (rather than omitting it) spells "no error", and treating it
      // as truthy here would try to read `.message` off `null` and throw `TypeError`
      // synchronously inside this stdout listener, same as the shape check above.
      if ("error" in parsed && parsed.error !== undefined && parsed.error !== null) {
        waiter.reject(new AgentCatalogError(
          "protocol",
          `codex app-server returned a JSON-RPC error: ${jsonRpcErrorMessage(parsed.error)}`,
        ));
      } else if ("result" in parsed) {
        waiter.resolve(parsed.result);
      } else {
        waiter.reject(new AgentCatalogError(
          "protocol",
          "codex app-server response carried neither result nor error.",
        ));
      }
    });

    stdout.on("data", (chunk: Buffer) => {
      try {
        lineReader.push(chunk);
      } catch (error) {
        // A synchronous throw out of a `stdout.on("data", ...)` listener is an uncaught
        // exception that crashes the whole host process, not just this fetch — the Obsidian
        // plugin runs this in-process, so an unhandled shape assertion here would take down the
        // user's editor, not just fail a CLI command. Nothing inside `lineReader.push` is
        // expected to throw any more (the guards above exist for that), but routing whatever
        // does through `fail()` keeps that guarantee even against a case not yet anticipated.
        fail(error instanceof AgentCatalogError
          ? error
          : new AgentCatalogError(
              "protocol",
              `codex app-server stdout handling failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            ));
      }
    });

    (async () => {
      await request("initialize", { clientInfo: { name: "shorthand-core", version: "0" } });
      notify("initialized");
      // Sent together, matching the captured working sequence, not one awaited before the
      // other: both are cheap reads on the server side and there is no dependency between them.
      const [models, account] = await Promise.all([
        collectModelPages(request),
        request("account/read", {}).then(parseAccountReadResult),
      ]);
      succeed(toCodexCatalog(models, account));
    })().catch(fail);
  });
}

/**
 * Follows `nextCursor` until the server reports no more pages, guarding against a server that
 * never terminates pagination: without a cap, a server repeating the same non-null cursor forever
 * (or `{data: [], nextCursor: "x"}` forever) would otherwise spin until the whole-handshake
 * timeout and report a bare `timeout` that hides pagination as the real cause. A single-page
 * catalog (every capture so far) makes one request and returns before either check matters.
 */
async function collectModelPages(
  request: (method: string, params?: unknown) => Promise<unknown>,
): Promise<readonly CodexCatalogModel[]> {
  const collected: CodexCatalogModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_MODEL_LIST_PAGES) {
      throw new AgentCatalogError(
        "protocol",
        `codex app-server model/list did not terminate pagination within ${MAX_MODEL_LIST_PAGES} pages.`,
      );
    }
    const result = parseModelListResult(await request("model/list", cursor === null ? {} : { cursor }));
    collected.push(...result.data);
    if (result.nextCursor !== null && result.nextCursor === cursor) {
      throw new AgentCatalogError(
        "protocol",
        "codex app-server model/list returned the same cursor twice; refusing to paginate forever.",
      );
    }
    cursor = result.nextCursor;
    if (cursor === null) break;
  }
  return collected;
}

/** Sane upper bound on `model/list` pages — see {@link collectModelPages}'s doc comment for what
 * it guards against. Far above any real catalog size (a handful of models as of codex-cli
 * 0.150.1) so it never fires for an honest server, however it paginates. */
const MAX_MODEL_LIST_PAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-RPC's `error` field is itself untrusted subprocess output — reading `.message` off it
 * without a shape check is the same `TypeError` risk `parsed.error` used to be at the top level,
 * just one field deeper. Falls back to the raw JSON so a malformed error object still surfaces
 * something a caller can read, rather than being swallowed for being the wrong shape. */
function jsonRpcErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}

/**
 * Validates one `model/list` entry against the fields `toCodexCatalog` actually reads, rather
 * than trusting a bare `as CodexCatalogModel`. Confirmed consequence of skipping this: a result
 * missing `data` used to throw `TypeError: page.data is not iterable` with no `.code`, which
 * `classifyCodexCatalogFailure` then reported as `spawn-failed` — telling the caller the
 * executable could not be spawned when the real problem was a shape mismatch on a perfectly
 * runnable server.
 */
function parseCodexCatalogModel(value: unknown): CodexCatalogModel {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.displayName !== "string"
    || typeof value.description !== "string"
  ) {
    throw new AgentCatalogError(
      "protocol",
      `codex app-server model/list returned a model entry missing id/displayName/description: ${JSON.stringify(value)}`,
    );
  }
  if (value.supportedReasoningEfforts !== undefined && !isEffortsList(value.supportedReasoningEfforts)) {
    throw new AgentCatalogError(
      "protocol",
      `codex app-server model/list's supportedReasoningEfforts had an unexpected shape for ${value.id}: ${JSON.stringify(value.supportedReasoningEfforts)}`,
    );
  }
  // Narrowed above to every field toCodexCatalog reads; `hidden` and `defaultReasoningEffort`
  // are read with `typeof`/`!== true` checks at their use sites and tolerate being absent or the
  // wrong type without throwing, so they are not re-validated here.
  return value as CodexCatalogModel;
}

function isEffortsList(value: unknown): value is readonly Readonly<{ reasoningEffort: string; description: string }>[] {
  return Array.isArray(value)
    && value.every((entry) => isRecord(entry) && typeof entry.reasoningEffort === "string");
}

/** Validates a raw `model/list` result and normalizes `nextCursor`: a server that omits the
 * field on its last page (rather than sending it as `null`) must still end pagination, and
 * `JSON.stringify({cursor: undefined})` serializes to `{}` — so folding "anything that isn't a
 * string" into `null` here, once, is what makes `collectModelPages`'s `cursor === null` check
 * correct instead of comparing `undefined !== null` and refetching page 1 forever. */
function parseModelListResult(value: unknown): CodexModelListResult {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new AgentCatalogError(
      "protocol",
      `codex app-server model/list returned a result missing a "data" array: ${JSON.stringify(value)}`,
    );
  }
  return {
    data: value.data.map(parseCodexCatalogModel),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
  };
}

/** Validates `account/read`'s result. A missing `account` key is a shape failure (`protocol`);
 * `account: null` is the documented signed-out state and passes straight through — see
 * `toCodexCatalog`'s doc comment for why those two must never be conflated. */
function parseAccountReadResult(value: unknown): CodexAccountReadResult {
  if (!isRecord(value) || !("account" in value)) {
    throw new AgentCatalogError(
      "protocol",
      `codex app-server account/read returned a result missing "account": ${JSON.stringify(value)}`,
    );
  }
  const account = value.account;
  if (account === null) return { account: null };
  if (!isRecord(account)) {
    throw new AgentCatalogError(
      "protocol",
      `codex app-server account/read's "account" field had an unexpected shape: ${JSON.stringify(value)}`,
    );
  }
  return { account: typeof account.email === "string" ? { email: account.email } : {} };
}

/**
 * Pure mapping from what the app-server returned to the shape catalog.ts defines, split out from
 * {@link listCodexModels} so it can be exercised against test/fixtures/codex-model-catalog.json
 * without spawning a subprocess.
 */
export function toCodexCatalog(models: readonly CodexCatalogModel[], account: CodexAccountReadResult): AgentCatalog {
  const email = account.account?.email;
  // Neither backend fails when signed out: `model/list` returns a shorter catalog (`gpt-5.2`
  // substituted for the whole `gpt-5.4` family) and no error, so sign-in must be read from
  // `account/read`'s own null, never inferred from a thrown error — see catalog.ts's
  // `AgentCatalog.signedIn` doc for what a consumer that conflated the two would get wrong.
  const signedIn = account.account !== null;
  const mapped: AgentModel[] = models
    // `listCodexModels` never sets `includeHidden`, so the server should already exclude
    // `gpt-reserve` and `codex-auto-review` — filtered again here so a server that ever changed
    // that default could not silently hand a picker a model nobody meant to offer.
    .filter((model) => model.hidden !== true)
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: model.description,
      efforts: (model.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort),
      ...(model.defaultReasoningEffort === undefined ? {} : { defaultEffort: model.defaultReasoningEffort }),
    }));
  return {
    models: mapped,
    signedIn,
    ...(signedIn && email !== undefined ? { account: email } : {}),
  };
}

/**
 * Classifies a raw spawn/process failure into the right `CatalogFailureReason`. ENOENT is the
 * only code specific enough to mean "no executable at that path"; every other spawn-time failure
 * (bad permissions, a binary that exists but will not run, a child that exits before the
 * handshake finishes) is reported as the more general "spawn-failed" rather than guessed at
 * further. An `AgentCatalogError` that already carries the right reason (a protocol failure or a
 * timeout from elsewhere in this module) passes through unchanged.
 */
function classifyCodexCatalogFailure(error: unknown, stderr = ""): AgentCatalogError {
  // Passed through unchanged rather than re-wrapped: an AgentCatalogError raised elsewhere in
  // this module (the handshake's own protocol/spawn-failed errors) already had its chance to
  // fold in stderr via withStderr at the point it was created — doing it again here would
  // either duplicate the text or, worse, attach stderr captured *after* that error already
  // described a different moment in the child's lifetime.
  if (error instanceof AgentCatalogError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  const reason: CatalogFailureReason = code === "ENOENT" ? "executable-not-found" : "spawn-failed";
  const message = error instanceof Error ? error.message : String(error);
  return new AgentCatalogError(
    reason,
    withStderr(`Failed to fetch the Codex model catalog: ${message}`, stderr),
    { cause: error },
  );
}
