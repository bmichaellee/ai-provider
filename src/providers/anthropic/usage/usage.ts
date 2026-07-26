import type { ContextUsage, ProviderKind, TurnUsage } from "../../../types";
import { DEFAULT_CONTEXT_WINDOW } from "../types";

/** The token fields both backends report, in their wire shape. */
export type RawUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/**
 * A context window is usable only if it is a positive, finite number. Guards
 * both the catalog miss (undefined) and a provider-reported window that is
 * zero or NaN — either would make percentUsed meaningless and could drive a
 * consumer's `contextWindow - sessionOverheadTokens` budget negative.
 */
export const usableWindow = (window: unknown): number | undefined =>
  typeof window === "number" && Number.isFinite(window) && window > 0
    ? window
    : undefined;

const cacheFields = (usage: RawUsage) => ({
  cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
});

export const contextUsageOf = (
  usage: RawUsage,
  meta: {
    contextWindow: number;
    iteration: number;
    providerKind: ProviderKind;
    sessionOverheadTokens?: number;
  },
): ContextUsage => {
  const { cacheCreationInputTokens, cacheReadInputTokens } = cacheFields(usage);
  const consumed =
    usage.input_tokens + cacheCreationInputTokens + cacheReadInputTokens;
  const contextWindow =
    usableWindow(meta.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextWindow,
    percentUsed: Math.round((consumed / contextWindow) * 1000) / 10,
    iteration: meta.iteration,
    providerKind: meta.providerKind,
    ...(meta.sessionOverheadTokens === undefined
      ? {}
      : { sessionOverheadTokens: meta.sessionOverheadTokens }),
  };
};

export const turnUsageOf = (
  usage: RawUsage,
  meta: {
    iterationCount: number;
    contextWindow: number;
    providerKind: ProviderKind;
    costUSD?: number;
    sessionOverheadTokens?: number;
  },
): TurnUsage => ({
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  ...cacheFields(usage),
  iterationCount: meta.iterationCount,
  contextWindow: usableWindow(meta.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
  ...(meta.costUSD === undefined ? {} : { costUSD: meta.costUSD }),
  providerKind: meta.providerKind,
  ...(meta.sessionOverheadTokens === undefined
    ? {}
    : { sessionOverheadTokens: meta.sessionOverheadTokens }),
});
