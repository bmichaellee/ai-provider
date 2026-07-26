import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  contextUsageSchema,
  providerKindSchema,
  toolActivitySchema,
  turnUsageSchema,
} from "./schemas";
import { claudeModelSchema } from "../providers";
import type {
  ClaudeModel,
  ContextUsage,
  ProviderKind,
  ToolActivity,
  TurnUsage,
} from "../index";

/**
 * The exported schemas exist so consumers can derive validators instead of
 * hand-mirroring our types — which only holds if the two never drift. These
 * assertions are compile-time: `bun run typecheck` fails if a field is added
 * to a type without being added to its schema, or vice versa.
 *
 * Exported so `noUnusedLocals` doesn't flag them.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

export type ContextUsageMatches = Expect<
  Equal<z.infer<typeof contextUsageSchema>, ContextUsage>
>;
export type TurnUsageMatches = Expect<
  Equal<z.infer<typeof turnUsageSchema>, TurnUsage>
>;
export type ToolActivityMatches = Expect<
  Equal<z.infer<typeof toolActivitySchema>, ToolActivity>
>;
export type ProviderKindMatches = Expect<
  Equal<z.infer<typeof providerKindSchema>, ProviderKind>
>;
export type ClaudeModelMatches = Expect<
  Equal<z.infer<typeof claudeModelSchema>, ClaudeModel>
>;

describe("exported schemas", () => {
  it("accepts a minimal context usage event", () => {
    const event: ContextUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextWindow: 1_000_000,
      percentUsed: 0,
      iteration: 1,
      providerKind: "anthropic",
    };
    expect(contextUsageSchema.parse(event)).toEqual(event);
  });

  it("accepts the local backend's extra fields", () => {
    const event: ContextUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextWindow: 1_000_000,
      percentUsed: 0,
      iteration: 1,
      providerKind: "local",
      sessionOverheadTokens: 65_000,
    };
    expect(contextUsageSchema.parse(event)).toEqual(event);
  });

  it("rejects a usage event missing a field the type requires", () => {
    const { iteration, ...withoutIteration } = {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextWindow: 1_000_000,
      percentUsed: 0,
      iteration: 1,
      providerKind: "anthropic",
    };
    void iteration;
    expect(contextUsageSchema.safeParse(withoutIteration).success).toBe(false);
  });

  it("rejects an unknown provider kind", () => {
    expect(providerKindSchema.safeParse("bedrock").success).toBe(false);
  });

  it("validates model ids, which consumers often hold as opaque strings", () => {
    expect(claudeModelSchema.safeParse("claude-opus-5").success).toBe(true);
    expect(claudeModelSchema.safeParse("claude-opus-4-8").success).toBe(true);
    expect(claudeModelSchema.safeParse("claude-opus-9").success).toBe(false);
  });

  it("accepts a turn usage event", () => {
    const event: TurnUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      iterationCount: 2,
      contextWindow: 200_000,
      providerKind: "local",
      costUSD: 0.5,
      sessionOverheadTokens: 65_000,
    };
    expect(turnUsageSchema.parse(event)).toEqual(event);
  });

  it("accepts each tool activity phase", () => {
    for (const phase of ["start", "end", "commentary"] as const) {
      const event: ToolActivity = {
        phase,
        toolName: "WebSearch",
        toolUseId: "tu1",
        summary: "searching",
      };
      expect(toolActivitySchema.parse(event)).toEqual(event);
    }
  });
});
