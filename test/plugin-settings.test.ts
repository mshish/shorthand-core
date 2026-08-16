import { describe, expect, test } from "bun:test";
import { DEFAULT_PLUGIN_SETTINGS, normalizePluginSettings } from "../src/plugin/settings.js";

describe("plugin settings normalization", () => {
  test("normalizes valid persisted values", () => {
    expect(normalizePluginSettings({
      handyExecutable: "  C:\\Apps\\handy.exe ",
      claudeExecutable: " C:\\Apps\\claude.exe ",
      sidecarDirectory: "./Calls\\Transcripts/",
      minNewChars: 42.9,
      minIntervalMs: 0,
      maxPasses: 7.8,
      maxUsd: 2.5,
      enableLiveEnhancement: false,
    })).toEqual({
      handyExecutable: "C:\\Apps\\handy.exe",
      claudeExecutable: "C:\\Apps\\claude.exe",
      sidecarDirectory: "Calls/Transcripts",
      minNewChars: 42,
      minIntervalMs: 0,
      maxPasses: 7,
      maxUsd: 2.5,
      enableLiveEnhancement: false,
    });
  });

  test("rejects absolute and traversing sidecar directories", () => {
    for (const sidecarDirectory of ["C:\\outside", "/outside", "../outside", "inside/../outside", ""]) {
      expect(normalizePluginSettings({ sidecarDirectory }).sidecarDirectory)
        .toBe(DEFAULT_PLUGIN_SETTINGS.sidecarDirectory);
    }
  });

  test("falls back for malformed numeric values", () => {
    expect(normalizePluginSettings({ minNewChars: 0, minIntervalMs: -1, maxPasses: 0, maxUsd: -1 }))
      .toMatchObject({
        minNewChars: DEFAULT_PLUGIN_SETTINGS.minNewChars,
        minIntervalMs: DEFAULT_PLUGIN_SETTINGS.minIntervalMs,
        maxPasses: DEFAULT_PLUGIN_SETTINGS.maxPasses,
        maxUsd: DEFAULT_PLUGIN_SETTINGS.maxUsd,
      });
  });
});
