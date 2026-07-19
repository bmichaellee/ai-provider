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

export type ContextUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextWindow: number;
  percentUsed: number;
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
  onUsage?: (usage: ContextUsage) => void;
};

export interface AIProvider {
  sendMessage<TApp = unknown>(
    messages: ProviderMessage[],
    options?: SendOptions<TApp>,
  ): Promise<string[]>;
  destroy(): Promise<void>;
}
