export type PluginMode = "idle" | "capturing" | "enhancing" | "budget-exhausted" | "error";

export type PluginUiState = Readonly<{
  mode: PluginMode;
  captureActive: boolean;
  passCount: number;
  message?: string;
}>;

export type PluginUiEvent =
  | Readonly<{ type: "capture-started" }>
  | Readonly<{ type: "capture-stopped" }>
  | Readonly<{ type: "enhancement-started"; passCount: number }>
  | Readonly<{ type: "enhancement-finished"; passCount: number }>
  | Readonly<{ type: "budget-exhausted"; passCount: number; message: string }>
  | Readonly<{ type: "error"; passCount?: number; message: string }>
  | Readonly<{ type: "clear-error" }>;

export const INITIAL_PLUGIN_STATE: PluginUiState = Object.freeze({
  mode: "idle",
  captureActive: false,
  passCount: 0,
});

export function reducePluginState(state: PluginUiState, event: PluginUiEvent): PluginUiState {
  switch (event.type) {
    case "capture-started":
      return { mode: "capturing", captureActive: true, passCount: 0 };
    case "capture-stopped":
      return state.mode === "error" || state.mode === "budget-exhausted"
        ? { ...state, captureActive: false }
        : { mode: "idle", captureActive: false, passCount: state.passCount };
    case "enhancement-started":
      return { mode: "enhancing", captureActive: state.captureActive, passCount: event.passCount };
    case "enhancement-finished":
      return {
        mode: state.captureActive ? "capturing" : "idle",
        captureActive: state.captureActive,
        passCount: event.passCount,
      };
    case "budget-exhausted":
      return {
        mode: "budget-exhausted",
        captureActive: state.captureActive,
        passCount: event.passCount,
        message: event.message,
      };
    case "error":
      return {
        mode: "error",
        captureActive: state.captureActive,
        passCount: event.passCount ?? state.passCount,
        message: event.message,
      };
    case "clear-error":
      return {
        mode: state.captureActive ? "capturing" : "idle",
        captureActive: state.captureActive,
        passCount: state.passCount,
      };
  }
}
