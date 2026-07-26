import { describe, expect, it } from "vitest";

import {
  ClaudeContextWindow,
  ClaudeMaxTokens,
  ClaudeModels,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  contextWindowFor,
  maxTokensFor,
  modelSupportsEffort,
  supportsEffort,
} from "./types";
import type { ClaudeModel } from "./types";

const catalogued = Object.keys(ClaudeContextWindow) as ClaudeModel[];

describe("model catalog", () => {
  it("points every bare family name at the latest release of that family", () => {
    expect(ClaudeModels).toEqual({
      Sonnet: "claude-sonnet-5",
      Opus: "claude-opus-5",
      Haiku: "claude-haiku-4-5",
      Fable: "claude-fable-5",
    });
  });

  it("keeps the superseded Opus selectable by literal without naming it", () => {
    expect(catalogued).toContain("claude-opus-4-8");
    expect(ClaudeMaxTokens["claude-opus-4-8"]).toBe(128000);
    expect(ClaudeContextWindow["claude-opus-4-8"]).toBe(1_000_000);
    expect(modelSupportsEffort["claude-opus-4-8"]).toBe(true);
    expect(Object.values(ClaudeModels)).not.toContain("claude-opus-4-8");
  });

  it("catalogues the same models in all three maps", () => {
    expect(Object.keys(ClaudeMaxTokens).sort()).toEqual([...catalogued].sort());
    expect(Object.keys(modelSupportsEffort).sort()).toEqual(
      [...catalogued].sort(),
    );
  });

  it("gives every catalogued model a usable window, output cap, and effort flag", () => {
    for (const model of catalogued) {
      expect(Number.isInteger(ClaudeContextWindow[model])).toBe(true);
      expect(ClaudeContextWindow[model]).toBeGreaterThan(0);
      expect(Number.isInteger(ClaudeMaxTokens[model])).toBe(true);
      expect(ClaudeMaxTokens[model]).toBeGreaterThan(0);
      expect(typeof modelSupportsEffort[model]).toBe("boolean");
    }
  });

  it("never lets a model's output cap exceed its context window", () => {
    for (const model of catalogued) {
      expect(ClaudeMaxTokens[model]).toBeLessThan(ClaudeContextWindow[model]);
    }
  });

  it("defaults to a catalogued model and a valid effort", () => {
    expect(catalogued).toContain(DEFAULT_MODEL);
    expect(["low", "medium", "high", "xhigh", "max"]).toContain(DEFAULT_EFFORT);
  });
});

describe("lookups for models outside the catalog", () => {
  it("falls back to the default model's window rather than an undefined one", () => {
    expect(contextWindowFor("claude-does-not-exist")).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
    expect(DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
  });

  it("falls back to the default model's output cap", () => {
    expect(maxTokensFor("opus")).toBe(ClaudeMaxTokens[DEFAULT_MODEL]);
  });

  it("returns the catalogued value for a known model", () => {
    expect(contextWindowFor(ClaudeModels.Haiku)).toBe(200_000);
    expect(maxTokensFor(ClaudeModels.Haiku)).toBe(64000);
    expect(contextWindowFor(ClaudeModels.Opus)).toBe(1_000_000);
  });

  it("assumes an unknown model has no effort support so the hint is dropped", () => {
    expect(supportsEffort("claude-does-not-exist")).toBe(false);
    expect(supportsEffort(ClaudeModels.Opus)).toBe(true);
    expect(supportsEffort(ClaudeModels.Haiku)).toBe(false);
  });
});
