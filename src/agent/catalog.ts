/**
 * The model catalog each agent backend can be asked for, in one shape.
 *
 * Both backends publish a catalog, and both publish it *per model* — which efforts a model
 * accepts is a property of the model, not of the backend. The static
 * `CLAUDE_EFFORT_LEVELS` / `CODEX_REASONING_EFFORTS` unions cannot express that, and a
 * consumer that offers a backend-wide union offers combinations the provider rejects:
 * Claude's Haiku accepts no effort at all, and Codex's `gpt-5.4` rejects the `max` and
 * `ultra` that `gpt-5.6-sol` accepts. Those unions stay as the synchronous type-guard for
 * stored settings; this is what a picker is built from.
 *
 * This catalog is the authority on what a given model accepts, because it is read from the
 * live CLI at runtime; `CLAUDE_EFFORT_LEVELS` and `CODEX_REASONING_EFFORTS` are a known-good
 * set frozen at the installed npm SDK's version, not the CLI's. The two can disagree — the
 * CLI is a separately-versioned binary resolved from the user's PATH (see docs/DESIGN.md) —
 * so `ClaudeAgentClientOptions.effort` and `CodexAgentClientOptions.modelReasoningEffort` are
 * typed as plain `string`, accepting whatever this catalog reported, rather than narrowed to
 * those unions.
 */

export type AgentModel = Readonly<{
  /**
   * The exact string the backend's own model option wants — Claude's `ModelInfo.value`
   * (an alias such as `sonnet` or `opus[1m]`, not always a wire id) and Codex's `Model.id`
   * slug. Never a display name.
   */
  id: string;
  displayName: string;
  description: string;
  /**
   * Efforts this model accepts, in the order the backend listed them. Empty means the model
   * takes no effort setting at all, which is a real state rather than a missing answer —
   * Claude's Haiku reports no `supportedEffortLevels`, and sending one is a mistake the
   * caller should be prevented from making rather than told about afterwards.
   *
   * Deliberately `readonly string[]`, not `readonly ClaudeEffort[]` / `readonly
   * CodexReasoningEffort[]`: this is discovered from the live CLI at runtime, and the CLI can
   * ship an effort level before the pinned npm SDK's static union knows about it. This array
   * is authoritative for what THIS model accepts; the unions are only the synchronous
   * known-good set used to validate a stored setting when no catalog is available to ask.
   */
  efforts: readonly string[];
  /** The backend's own default, when it names one. Not a fallback this module invents. */
  defaultEffort?: string;
}>;

export type AgentCatalog = Readonly<{
  models: readonly AgentModel[];
  /**
   * Whether the backend's CLI is signed in.
   *
   * Kept separate from the fetch outcome because neither backend *fails* when signed out —
   * both return a shorter catalog and no error. Claude drops Fable; Codex substitutes
   * `gpt-5.2` for the `gpt-5.4` family. A consumer that inferred sign-in from a thrown
   * error would silently present a signed-out user a degraded list as if it were theirs.
   */
  signedIn: boolean;
  /** Identifies the signed-in account to the user, so they can see *which* login is in use. */
  account?: string;
}>;

/**
 * Why a catalog could not be fetched at all, as opposed to a catalog that came back short
 * because nobody is signed in. Consumers disable a picker on this; they prompt for a login
 * on `signedIn: false`. Conflating the two produces the wrong instruction for both.
 */
export type CatalogFailureReason = "executable-not-found" | "spawn-failed" | "timeout" | "protocol";

export class AgentCatalogError extends Error {
  readonly reason: CatalogFailureReason;

  constructor(reason: CatalogFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentCatalogError";
    this.reason = reason;
  }
}

/**
 * How long a catalog fetch may take before it is abandoned. Both probes are sub-second on a
 * warm machine (measured: ~0.6s for Codex's app-server, ~1.5s for Claude's SDK handshake);
 * the budget is set well above that because the cost of waiting is a settings row that says
 * "loading", while the cost of giving up early is a picker that appears broken on a cold
 * start or a slow disk.
 */
export const CATALOG_TIMEOUT_MS = 20_000;
