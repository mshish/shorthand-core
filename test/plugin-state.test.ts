import { describe, expect, test } from "bun:test";
import { INITIAL_PLUGIN_STATE, reducePluginState } from "../src/plugin/state.js";

describe("plugin status state machine", () => {
  test("returns to capture after an enhancement pass", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const enhancing = reducePluginState(capturing, { type: "enhancement-started", passCount: 0 });
    expect(reducePluginState(enhancing, { type: "enhancement-finished", passCount: 1 }))
      .toEqual({ mode: "capturing", captureActive: true, passCount: 1 });
  });

  test("keeps capture active when the enhancement budget is exhausted", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    expect(reducePluginState(capturing, {
      type: "budget-exhausted", passCount: 3, message: "Pass budget exhausted",
    })).toEqual({
      mode: "budget-exhausted",
      captureActive: true,
      passCount: 3,
      message: "Pass budget exhausted",
    });
  });

  test("an error can be cleared without forgetting an active capture", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const failed = reducePluginState(capturing, { type: "error", message: "locked" });
    expect(reducePluginState(failed, { type: "clear-error" }))
      .toEqual({ mode: "capturing", captureActive: true, passCount: 0 });
  });
});
