// Runs the real Claude Agent SDK under a global AbortController that is not Node's, the way
// Obsidian's Electron renderer does: there the global is the browser's while `node:events` is
// Node's, and Node's setMaxListeners rejects a signal from the other realm. It runs as its own
// process because agent-client-query.test.ts replaces the SDK module process-wide.
//
// Usage: <runtime> foreign-realm-claude.ts <claude executable>. Prints one JSON line.
type Listener = (event: { readonly type: string }) => void;

class ForeignAbortSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: Listener | null = null;
  readonly #listeners = new Map<Listener, boolean>();

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    if (type === "abort") this.#listeners.set(listener, options?.once === true);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "abort") this.#listeners.delete(listener);
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  fire(): void {
    const event = { type: "abort" };
    this.onabort?.(event);
    for (const [listener, once] of [...this.#listeners]) {
      if (once) this.#listeners.delete(listener);
      listener(event);
    }
  }
}

class ForeignAbortController {
  readonly signal = new ForeignAbortSignal();

  abort(reason: unknown = new Error("This operation was aborted")): void {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    this.signal.fire();
  }
}

const executable = process.argv[2];
if (executable === undefined) throw new Error("Expected a Claude executable path.");

globalThis.AbortController = ForeignAbortController as unknown as typeof AbortController;
const { ClaudeAgentClient, listClaudeModels } = await import("../../src/agent/client.js");

function outcomeOf(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error === "object" && error !== null && "reason" in error ? { reason: error.reason } : {}),
  };
}

const outcome: Record<string, unknown> = {};
try {
  await listClaudeModels({ executableOverride: executable });
  outcome.catalog = { resolved: true };
} catch (error) {
  outcome.catalog = outcomeOf(error);
}
try {
  await new ClaudeAgentClient().query({
    prompt: "",
    systemPrompt: "",
    tools: [],
    settingSources: [],
    maxTurns: 1,
    outputSchema: { type: "object" },
    pathToClaudeCodeExecutable: executable,
  });
  outcome.query = { resolved: true };
} catch (error) {
  outcome.query = outcomeOf(error);
}
outcome.globalRestored = globalThis.AbortController === (ForeignAbortController as unknown);
console.log(JSON.stringify(outcome));
process.exit(0);
