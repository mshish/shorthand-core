/**
 * The executable contracts core publishes: the `NoteSink` port, and the two credentials
 * files core reads but does not write — Google's, and the LLM provider profile.
 *
 * One specifier serves them all because `shorthand-core/testing` is described as the
 * executable contract, singular, and further subpaths would widen the exports map for
 * no reader benefit. The cost that buys is that a sink implementer resolves this file
 * too — which is why each credentials module imports everything it needs at runtime
 * dynamically, so nobody picks up google-auth-library, or core's agent module, to run
 * the sink suite.
 *
 * Explicit named re-exports only. `export *` is banned here for the same reason it is
 * banned in index.ts.
 */

export { NOTE_SINK_CONFORMANCE_SCENARIOS, describeNoteSinkConformance } from "./sink-conformance.js";
export type {
  ConformanceTestPrimitives,
  SinkConformanceScenario,
  SinkConformanceSupport,
  SinkHarness,
  SinkHarnessFactory,
} from "./sink-conformance.js";

export {
  GOOGLE_CREDENTIALS_CONFORMANCE_SCENARIOS,
  GOOGLE_CREDENTIALS_FIXTURES,
  describeGoogleCredentialsConformance,
} from "./google-credentials-conformance.js";
export type {
  CredentialsConformanceScenario,
  CredentialsConformanceSupport,
  CredentialsFixture,
  CredentialsGoldenFixture,
  CredentialsHarnessFactory,
  CredentialsWriterHarness,
} from "./google-credentials-conformance.js";

export {
  LLM_CREDENTIALS_CONFORMANCE_SCENARIOS,
  LLM_CREDENTIALS_FIXTURES,
  describeLlmCredentialsConformance,
} from "./llm-credentials-conformance.js";
export type {
  LlmCredentialsConformanceScenario,
  LlmCredentialsConformanceSupport,
  LlmCredentialsFixture,
  LlmCredentialsGoldenFixture,
  LlmCredentialsHarnessFactory,
  LlmCredentialsWriterHarness,
} from "./llm-credentials-conformance.js";
