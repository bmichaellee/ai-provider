const Sonnet = "claude-sonnet-5";
const Opus = "claude-opus-4-8";
const Haiku = "claude-haiku-4-5";
const Fable = "claude-fable-5";

export type ClaudeModel =
  typeof Sonnet | typeof Opus | typeof Haiku | typeof Fable;

export const ClaudeModels = { Sonnet, Opus, Haiku, Fable } as const;

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type CacheControlEphemeral = { type: "ephemeral"; ttl?: "5m" | "1h" };

export const ClaudeMaxTokens: Record<ClaudeModel, number> = {
  [Sonnet]: 128000,
  [Opus]: 128000,
  [Haiku]: 64000,
  [Fable]: 128000,
};

export const ClaudeContextWindow: Record<ClaudeModel, number> = {
  [Sonnet]: 1_000_000,
  [Opus]: 1_000_000,
  [Haiku]: 200_000,
  [Fable]: 1_000_000,
};

export const modelSupportsEffort: Record<ClaudeModel, boolean> = {
  [Sonnet]: true,
  [Opus]: true,
  [Fable]: true,
  [Haiku]: false,
};

export const DEFAULT_MODEL: ClaudeModel = Sonnet;
export const DEFAULT_EFFORT: ClaudeEffort = "high";
