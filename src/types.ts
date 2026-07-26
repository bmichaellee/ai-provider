import type { z } from "zod";

import type {
  CacheControlEphemeral,
  ClaudeEffort,
  ClaudeModel,
} from "./providers/anthropic/types";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MessageRole = ChatMessage["role"];

export type TextBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControlEphemeral;
};

export type SystemPrompt = string | TextBlock[];

export type MessageContent = string | TextBlock[];

export type ProviderMessage = {
  role: MessageRole;
  content: MessageContent;
};

export type ProviderKind = "anthropic" | "local";

export type ContextUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextWindow: number;
  /**
   * (inputTokens + cacheCreationInputTokens + cacheReadInputTokens) /
   * contextWindow * 100, rounded to one decimal — THIS call's live window
   * fullness on a 0-100 scale, never a running total.
   */
  percentUsed: number;
  /** 1-based index of the model API call within this sendMessage turn. */
  iteration: number;
  /** Backend that produced this event. */
  providerKind: ProviderKind;
  /**
   * Estimated harness overhead included in this call's context beyond
   * app-supplied content (local backend only).
   */
  sessionOverheadTokens?: number;
};

/**
 * Cumulative totals for one sendMessage turn. Deliberately has no percentUsed:
 * summed tokens over the window is not a fullness measure.
 */
export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Number of model API calls made during the turn. */
  iterationCount: number;
  /**
   * Authoritative window when the backend reports one (local: SDK modelUsage),
   * else the model map.
   */
  contextWindow: number;
  /** Provider-reported cost for the turn (local backend only). */
  costUSD?: number;
  providerKind: ProviderKind;
  /**
   * Estimated harness overhead carried in *each* call's context beyond
   * app-supplied content (local backend only) — the same per-call figure
   * ContextUsage reports, not a turn total. Do not multiply by
   * iterationCount. Budget app content for the next call against
   * contextWindow - sessionOverheadTokens.
   */
  sessionOverheadTokens?: number;
};

export type ToolActivityPhase = "start" | "end" | "commentary";

/**
 * A backend-internal tool event: a built-in tool the underlying session ran on
 * its own, or the working commentary the model wrote alongside that call.
 * App-supplied tools never appear here — they flow through ToolSpec.run.
 */
export type ToolActivity = {
  phase: ToolActivityPhase;
  /** Tool being invoked; for commentary, the tool whose call the text accompanies. */
  toolName: string;
  /** Provider id correlating start/end/commentary of one invocation. */
  toolUseId: string;
  /** One line, whitespace-collapsed and truncated — safe for a diagnostic log row. */
  summary: string;
  /** Untruncated text: JSON input (start), result text (end), full commentary. */
  detail?: string;
  /** End phase only: the tool result was an error. */
  isError?: boolean;
};

export type ToolContext<TApp = unknown> = {
  stop: boolean;
  app?: TApp;
};

export type ToolSpec<Input = any, TApp = unknown> = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  run: (input: Input, ctx?: ToolContext<TApp>) => Promise<string>;
};

export type SendOptions<TApp = unknown> = {
  model?: ClaudeModel;
  effort?: ClaudeEffort;
  system?: SystemPrompt;
  tools?: ToolSpec<any, TApp>[];
  context?: TApp;
  stopText?: string;
  onText?: (segment: string) => void;
  /**
   * Fires once per model API call, with that single call's usage. On the
   * local backend, calls made by subagents are excluded — they describe a
   * subagent's context, not this conversation's; their spend still lands in
   * onTurnUsage totals.
   */
  onUsage?: (usage: ContextUsage) => void;
  /** Fires at most once per sendMessage, after the final model call, with turn totals. */
  onTurnUsage?: (usage: TurnUsage) => void;
  /** Fires for backend built-in tool activity (start/end) and its interstitial commentary. */
  onToolActivity?: (activity: ToolActivity) => void;
};

export interface AIProvider {
  /**
   * Which backend this client is: "local" is a keyless local Claude Code
   * session; anything else is a metered API.
   */
  readonly providerKind: ProviderKind;
  sendMessage<TApp = unknown>(
    messages: ProviderMessage[],
    options?: SendOptions<TApp>,
  ): Promise<string[]>;
  destroy(): Promise<void>;
}
