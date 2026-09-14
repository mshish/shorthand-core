/**
 * The core entry point. Consumers import this package by name — never a deep
 * path — so extracting core to its own repo stays a directory move plus a
 * dependency line.
 *
 * Explicit named re-exports only. `export *` would pull every incidental module
 * on the re-exported files' graph into consumers' bundles (the plugin bundle is
 * already ~6.7 MB), and would silently widen the public surface every time a new
 * module gains an export.
 *
 * Block-format internals and test seams (`readCurrentBlock`, `writeSections`,
 * `hashBlock`, `parseSections`, the marker constants, `detectLineEnding`,
 * `NdjsonDecoder`, `buildClaudeAgentOptions`, `createVaultToolGuard`,
 * `ExecutableAgentStub`, `extractUserNotes`) are deliberately absent: exporting
 * them would re-create exactly the coupling the sink port removed.
 */

export { EnhanceRunner } from "./agent/runner.js";
export type { EnhanceRunnerOptions, EnhanceStatus, PassOutcome } from "./agent/runner.js";

export { busySinkError, sinkError } from "./note/sink.js";
export type {
  NoteSink,
  SinkError,
  SinkErrorCode,
  SinkReadResult,
  SinkSnapshot,
  SinkWriteResult,
} from "./note/sink.js";

export { tokenError } from "./auth/token-provider.js";
export type { TokenError, TokenErrorCode, TokenProvider, TokenResult } from "./auth/token-provider.js";

export type { Section } from "./note/markers.js";

export { BEGIN_MODES, CAPTURE_PHASES, KNOWN_REFUSAL_REASONS, KNOWN_START_FAILURE_CODES, StreamClient } from "./stream/client.js";
export type {
  BeginMode,
  CapturePhase,
  ExitDiagnosis,
  KnownRefusalReason,
  KnownStartFailureCode,
  StreamClientOptions,
  WireEvent,
} from "./stream/client.js";

export { ShorthandControl } from "./stream/control.js";
export type { ControlResult, ControlSignal, ShorthandControlOptions } from "./stream/control.js";

export { enhancementDelta, TranscriptStore } from "./stream/transcript.js";
export type { TranscriptUpdate } from "./stream/transcript.js";

export { SidecarWriter } from "./note/sidecar.js";
export type { SidecarStore, SidecarWriterOptions } from "./note/sidecar.js";

export { CLAUDE_EFFORT_LEVELS, ClaudeAgentClient, detectClaudeExecutable, listClaudeModels } from "./agent/client.js";
export type { ClaudeAgentClientOptions, ClaudeEffort, ListClaudeModelsOptions } from "./agent/client.js";

// The catalog a picker is built from. `CLAUDE_EFFORT_LEVELS` and `CODEX_REASONING_EFFORTS`
// above stay exported alongside it and are not superseded: they are the synchronous guard a
// consumer needs when validating a stored setting at load, where no catalog can be awaited.
// `AgentCatalog` is what a consumer offers a user; the unions are what it validates against.
export { AgentCatalogError, CATALOG_TIMEOUT_MS } from "./agent/catalog.js";
export type { AgentCatalog, AgentModel, CatalogFailureReason } from "./agent/catalog.js";

export { listCodexModels } from "./agent/codex-app-server.js";
export type { ListCodexModelsOptions } from "./agent/codex-app-server.js";

export {
  CODEX_REASONING_EFFORTS,
  CodexAgentClient,
  detectCodexExecutable,
  resolveCodexBaseUrl,
  resolveCodexModel,
} from "./agent/codex-client.js";
export type { CodexAgentClientOptions, CodexReasoningEffort } from "./agent/codex-client.js";

export { listAcpModels } from "./agent/acp-catalog.js";
export type { ListAcpModelsOptions } from "./agent/acp-catalog.js";

export {
  AcpAgentClient,
  DEFAULT_ACP_TIMEOUT_MS,
  detectCursorExecutable,
} from "./agent/acp-client.js";
export type {
  AcpAgentClientOptions,
  AcpTransportConfig,
} from "./agent/acp-client.js";

export { APP_MANAGED_API_KEY, LlmAgentClient, llmEndpointOrigin } from "./agent/llm-client.js";
export type { LlmAgentClientOptions } from "./agent/llm-client.js";

export type { LlmProfile, LlmProviderId } from "./agent/llm-credentials.js";

/**
 * Legacy file, read once by the plugin's migration; removed in 0.23. Nothing in core reads
 * it: the key lives in the Shorthand app's keyring and `createAppFetch` is the only path to
 * an authenticated request.
 */
export { llmCredentialsPath, readLlmCredentials } from "./agent/llm-credentials.js";
export type { LlmCredentials, LlmCredentialsReadResult } from "./agent/llm-credentials.js";

/**
 * The Shorthand app's request socket: the channel core uses to make an authenticated call
 * without ever holding the secret it needs. `createAppFetch` and
 * `createAppWebSocketConstructor` are what an `LlmAgentClient` or an ACP network transport
 * is built on; `ShorthandAppClient.connect` is what produces the client they take.
 */
export { APP_PROTOCOL_VERSION, AppUnavailableError, ShorthandAppClient } from "./app/client.js";
export type {
  AppClientLike,
  AppCredentialSlot,
  AppCredentialStatus,
  AppEvent,
  AppUnavailableReason,
  ShorthandAppClientOptions,
} from "./app/client.js";

export { readDiscovery } from "./app/discovery.js";
export type { RequestSocketDiscovery } from "./app/discovery.js";

export { createAppFetch } from "./app/fetch.js";

export { createAppWebSocketConstructor } from "./app/websocket.js";
export type { AppWebSocketConstructor, AppWebSocketEvent, AppWebSocketLike } from "./app/websocket.js";

export {
  DEFAULT_ASSISTED_NOTES_EDITORIAL_GUIDANCE,
  DEFAULT_EDITORIAL_GUIDANCE,
  DEFAULT_MEETING_EDITORIAL_GUIDANCE,
  ENHANCEMENT_SAFETY_PREAMBLE,
  MAX_GUIDANCE_CHARACTERS,
  MAX_USER_NAME_CHARACTERS,
} from "./agent/contract.js";

export { parseTemplateSections } from "./note/template.js";
export type { TemplateSectionsResult } from "./note/template.js";

export type {
  AgentClient,
  AgentQueryRequest,
  AgentQueryResponse,
  AgentTier,
  NoteTakingMode,
} from "./agent/contract.js";

export type { NoteTakingContext } from "./agent/runner.js";

export { CORE_VERSION, DEFAULT_CONFIG, detectShorthandExecutable, requestSocketDiscoveryPath } from "./config.js";
export type { ShorthandConfig } from "./config.js";
