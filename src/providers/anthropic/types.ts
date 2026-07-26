import { z } from "zod";

const Sonnet = "claude-sonnet-5";
const Opus = "claude-opus-5";
const Haiku = "claude-haiku-4-5";
const Fable = "claude-fable-5";

/**
 * Still selectable by literal and still catalogued, but deliberately has no
 * named constant: bare family names track the latest release, so pinning an
 * older Opus is a choice a caller should have to spell out.
 */
const Opus48 = "claude-opus-4-8";

/** Every model id the catalog knows. */
const CLAUDE_MODELS = [Sonnet, Opus, Opus48, Haiku, Fable] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export const ClaudeModels = { Sonnet, Opus, Haiku, Fable } as const;

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/**
 * Validates a model id held as an opaque string — a config value, a database
 * row, a request body — before it reaches sendMessage.
 */
export const claudeModelSchema = z.enum(CLAUDE_MODELS);

export const claudeEffortSchema = z.enum(CLAUDE_EFFORTS);

export type CacheControlEphemeral = { type: "ephemeral"; ttl?: "5m" | "1h" };

export const ClaudeMaxTokens: Record<ClaudeModel, number> = {
  [Sonnet]: 128000,
  [Opus]: 128000,
  [Opus48]: 128000,
  [Haiku]: 64000,
  [Fable]: 128000,
};

export const ClaudeContextWindow: Record<ClaudeModel, number> = {
  [Sonnet]: 1_000_000,
  [Opus]: 1_000_000,
  [Opus48]: 1_000_000,
  [Haiku]: 200_000,
  [Fable]: 1_000_000,
};

export const modelSupportsEffort: Record<ClaudeModel, boolean> = {
  [Sonnet]: true,
  [Opus]: true,
  [Opus48]: true,
  [Fable]: true,
  [Haiku]: false,
};

export const DEFAULT_MODEL: ClaudeModel = Sonnet;
export const DEFAULT_EFFORT: ClaudeEffort = "high";

/** Window used when the catalog has no entry for a model. */
export const DEFAULT_CONTEXT_WINDOW = ClaudeContextWindow[DEFAULT_MODEL];

/**
 * The catalog's context window for `model`, falling back to the default
 * model's window when there is no entry. Models outside ClaudeModel reach
 * here at runtime only — a string from config, a row written by an older
 * release, or a Claude Code alias on the local backend. The fallback keeps
 * percentUsed a real number on a 0-100 scale; an undefined window makes it
 * NaN, which serializes to null and silently blanks a caller's meter.
 */
export const contextWindowFor = (model: string): number =>
  ClaudeContextWindow[model as ClaudeModel] ?? DEFAULT_CONTEXT_WINDOW;

/** As contextWindowFor, for the per-request output cap. */
export const maxTokensFor = (model: string): number =>
  ClaudeMaxTokens[model as ClaudeModel] ?? ClaudeMaxTokens[DEFAULT_MODEL];

/**
 * Whether `model` accepts an effort hint. Unknown models are assumed not to,
 * so the parameter is dropped rather than risking a rejected request.
 */
export const supportsEffort = (model: string): boolean =>
  modelSupportsEffort[model as ClaudeModel] ?? false;
