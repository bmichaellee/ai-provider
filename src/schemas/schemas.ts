import { z } from "zod";

/**
 * Runtime schemas for the event shapes this package emits.
 *
 * These are hand-written to mirror the types in `../types`, not derived from
 * them (nor the types derived from these). Deriving either direction would
 * lose the per-field documentation on the types, or make the package's core
 * contract depend on zod's inference. `schemas.test.ts` asserts the two stay
 * equivalent at compile time, so drift fails the build rather than shipping.
 *
 * Deliberately not `.strict()`: a consumer forwarding an event from a newer
 * copy of this package through an older schema should see unknown keys
 * stripped, not an exception.
 */

export const providerKindSchema = z.enum(["anthropic", "local"]);

export const contextUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  contextWindow: z.number(),
  percentUsed: z.number(),
  iteration: z.number(),
  providerKind: providerKindSchema,
  sessionOverheadTokens: z.number().optional(),
});

export const turnUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  iterationCount: z.number(),
  contextWindow: z.number(),
  costUSD: z.number().optional(),
  providerKind: providerKindSchema,
  sessionOverheadTokens: z.number().optional(),
});

export const toolActivityPhaseSchema = z.enum(["start", "end", "commentary"]);

export const toolActivitySchema = z.object({
  phase: toolActivityPhaseSchema,
  toolName: z.string(),
  toolUseId: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  isError: z.boolean().optional(),
});
