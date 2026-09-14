/**
 * The executable contracts core publishes: the `NoteSink` port, and the Google credentials
 * file core reads but does not write.
 *
 * There is no LLM-credentials contract here any more. The LLM provider key is held by the
 * Shorthand app and injected by it (`createAppFetch`), so there is no file for a consumer
 * to write and nothing for core to specify the bytes of.
 *
 * One specifier serves both because `shorthand-core/testing` is described as the
 * executable contract, singular, and further subpaths would widen the exports map for
 * no reader benefit. The cost that buys is that a sink implementer resolves this file
 * too — which is why the credentials module imports everything it needs at runtime
 * dynamically, so nobody picks up google-auth-library to run the sink suite.
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
