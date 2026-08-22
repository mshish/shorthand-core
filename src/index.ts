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

export { StreamClient } from "./stream/client.js";
export type { ExitDiagnosis, StreamClientOptions } from "./stream/client.js";

export { ShorthandControl } from "./stream/control.js";
export type { ControlResult, ControlSignal, ShorthandControlOptions } from "./stream/control.js";

export { enhancementDelta, TranscriptStore } from "./stream/transcript.js";
export type { TranscriptUpdate } from "./stream/transcript.js";

export { SidecarWriter } from "./note/sidecar.js";
export type { SidecarWriterOptions } from "./note/sidecar.js";

export { ClaudeAgentClient, detectClaudeExecutable } from "./agent/client.js";

export { LlmAgentClient } from "./agent/llm-client.js";
export type { LlmAgentClientOptions } from "./agent/llm-client.js";

export { llmCredentialsPath, readLlmCredentials } from "./agent/llm-credentials.js";
export type { LlmCredentials, LlmCredentialsReadResult, LlmProviderId } from "./agent/llm-credentials.js";

export { DEFAULT_EDITORIAL_GUIDANCE, ENHANCEMENT_SAFETY_PREAMBLE, MAX_GUIDANCE_CHARACTERS } from "./agent/contract.js";

export { parseTemplateSections } from "./note/template.js";
export type { TemplateSectionsResult } from "./note/template.js";

export type {
  AgentClient,
  AgentQueryRequest,
  AgentQueryResponse,
  AgentTier,
} from "./agent/contract.js";

export { DEFAULT_CONFIG, detectShorthandExecutable } from "./config.js";
export type { ShorthandConfig } from "./config.js";
