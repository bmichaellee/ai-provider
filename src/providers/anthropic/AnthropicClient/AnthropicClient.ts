import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import {
  ClaudeContextWindow,
  ClaudeMaxTokens,
  DEFAULT_MODEL,
  modelSupportsEffort,
} from "../types";
import type {
  AIProvider,
  ContextUsage,
  ProviderMessage,
  SendOptions,
  ToolContext,
  ToolSpec,
  TurnUsage,
} from "../../../types";
import { executeTool } from "../../../executeTool";

const MAX_TOOL_TURNS = 8;

const toAnthropicTool = (tool: ToolSpec<any, any>): Anthropic.Tool => ({
  name: tool.name,
  description: tool.description,
  input_schema: z.toJSONSchema(tool.schema) as Anthropic.Tool.InputSchema,
});

const textOf = (content: Anthropic.ContentBlock[]): string =>
  content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

const usageOf = (
  usage: Anthropic.Usage | undefined,
  contextWindow: number,
  iteration: number,
): ContextUsage | undefined => {
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
  const consumed =
    inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  return {
    inputTokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextWindow,
    percentUsed: Math.round((consumed / contextWindow) * 1000) / 10,
    iteration,
    providerKind: "anthropic",
  };
};

export class AnthropicClient implements AIProvider {
  readonly providerKind = "anthropic" as const;

  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async sendMessage<TApp = unknown>(
    messages: ProviderMessage[],
    options: SendOptions<TApp> = {},
  ): Promise<string[]> {
    const model = options.model ?? DEFAULT_MODEL;
    const effort =
      options.effort && modelSupportsEffort[model] ? options.effort : undefined;
    const tools = options.tools ?? [];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const conversation: Anthropic.MessageParam[] = [...messages];
    const ctx: ToolContext<TApp> = {
      stop: false,
      app: options.context,
    };

    const segments: string[] = [];
    const emit = (text: string) => {
      if (!text) return;
      segments.push(text);
      options.onText?.(text);
    };

    const turnTotals: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      iterationCount: 0,
      contextWindow: ClaudeContextWindow[model],
      providerKind: "anthropic",
    };
    const emitTurnUsage = () => {
      if (turnTotals.iterationCount) options.onTurnUsage?.(turnTotals);
    };

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = this.client.messages.stream({
        model,
        max_tokens: ClaudeMaxTokens[model],
        system: options.system,
        ...(effort ? { output_config: { effort } } : {}),
        ...(tools.length ? { tools: tools.map(toAnthropicTool) } : {}),
        messages: conversation,
      });
      const message = await stream.finalMessage();

      const usage = usageOf(message.usage, ClaudeContextWindow[model], turn + 1);
      if (usage) {
        turnTotals.inputTokens += usage.inputTokens;
        turnTotals.outputTokens += usage.outputTokens;
        turnTotals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
        turnTotals.cacheReadInputTokens += usage.cacheReadInputTokens;
        turnTotals.iterationCount += 1;
        options.onUsage?.(usage);
      }

      if (message.stop_reason !== "tool_use") {
        emit(textOf(message.content));
        emitTurnUsage();
        return segments;
      }

      conversation.push({ role: "assistant", content: message.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          emit(block.text);
          continue;
        }
        if (block.type !== "tool_use") continue;

        const tool = byName.get(block.name);
        if (!tool) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          });
          continue;
        }
        const parsed = tool.schema.safeParse(block.input);
        if (!parsed.success) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Invalid input for tool ${block.name}: ${parsed.error.message}`,
            is_error: true,
          });
          continue;
        }
        try {
          const result = await executeTool(tool, parsed.data, ctx);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: error instanceof Error ? error.message : String(error),
            is_error: true,
          });
        }
      }
      conversation.push({ role: "user", content: toolResults });

      if (ctx.stop) {
        if (!segments.length && options.stopText) emit(options.stopText);
        emitTurnUsage();
        return segments;
      }
    }

    throw new Error(
      `AnthropicClient exceeded ${MAX_TOOL_TURNS} tool-use turns`,
    );
  }

  async destroy(): Promise<void> {}
}
