/**
 * Obsidian-plugin UI state and settings.
 *
 * This is consumer-owned code parked under `src/` so it stays inside the
 * typecheck include (`plugin/**` is not typechecked yet — that is Phase B2). It
 * is NOT part of core's contract: an API-backed sink has no plugin settings and
 * no status-bar reducer, and none of it may appear on the "." surface.
 *
 * It gets its own subpath rather than a relative-import exception so the ban on
 * deep imports stays absolute and mechanically enforced. When the workspace
 * split lands, this directory is exactly what moves into the plugin package and
 * this subpath disappears.
 */

export {
  DEFAULT_PLUGIN_SETTINGS,
  normalizePluginSettings,
  type HandyNotesPluginSettings,
} from "./settings.js";

export {
  INITIAL_PLUGIN_STATE,
  reducePluginState,
  type PluginMode,
  type PluginUiEvent,
  type PluginUiState,
} from "./state.js";
