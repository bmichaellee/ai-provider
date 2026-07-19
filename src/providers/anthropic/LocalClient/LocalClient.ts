import { ClaudeContextWindow, DEFAULT_MODEL } from "../types";
import type {
  AIProvider,
  ContextUsage,
  MessageContent,
  ProviderMessage,
  SendOptions,
  SystemPrompt,
  ToolContext,
  ToolSpec,
} from "../../../types";
import { executeTool } from "../../../executeTool";

const MCP_SERVER = "tools";

const flattenText = (content: SystemPrompt | MessageContent): string =>
  typeof content === "string"
    ? content
    : content.map((block) => block.text).join("");

type AgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");

const loadAgentSdk = async (): Promise<AgentSdk> => {
  try {
    return await import("@anthropic-ai/claude-agent-sdk");
  } catch (error) {
    throw new Error(
      'The local backend needs the optional peer "@anthropic-ai/claude-agent-sdk" (and a local Claude Code install). Add that package, or select the "anthropic" backend with an API key.',
      { cause: error },
    );
  }
};

type SdkUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

const usageOf = (usage: SdkUsage, contextWindow: number): ContextUsage => {
  const inputTokens = usage.input_tokens;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens;
  const cacheReadInputTokens = usage.cache_read_input_tokens;
  const consumed =
    inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  return {
    inputTokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextWindow,
    percentUsed: Math.round((consumed / contextWindow) * 1000) / 10,
  };
};

const toSdkTool = (
  sdkTool: AgentSdk["tool"],
  spec: ToolSpec<any, any>,
  ctx: ToolContext<any>,
) =>
  sdkTool(spec.name, spec.description, spec.schema.shape, async (args) => {
    try {
      return {
        content: [
          { type: "text" as const, text: await executeTool(spec, args, ctx) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  });

export class LocalClient implements AIProvider {
  readonly sessionIds: string[] = [];

  async sendMessage<TApp = unknown>(
    messages: ProviderMessage[],
    options: SendOptions<TApp> = {},
  ): Promise<string[]> {
    const { query, tool, createSdkMcpServer } = await loadAgentSdk();

    const prompt = messages
      .map((message) => `${message.role}: ${flattenText(message.content)}`)
      .join("\n\n");
    const tools = options.tools ?? [];
    const contextWindow = ClaudeContextWindow[options.model ?? DEFAULT_MODEL];
    const ctx: ToolContext<TApp> = {
      stop: false,
      app: options.context,
    };

    const segments: string[] = [];
    const emit = (text: string) => {
      if (!text.trim()) return;
      segments.push(text);
      options.onText?.(text);
    };
    const emitStopText = () => {
      if (!segments.length && options.stopText) emit(options.stopText);
    };

    const mcpServers = tools.length
      ? {
          [MCP_SERVER]: createSdkMcpServer({
            name: MCP_SERVER,
            version: "1.0.0",
            tools: tools.map((t) => toSdkTool(tool, t, ctx)),
          }),
        }
      : undefined;

    const queryIterator = query({
      prompt,
      options: {
        model: options.model,
        ...(options.effort ? { effort: options.effort } : {}),
        systemPrompt:
          options.system === undefined
            ? undefined
            : flattenText(options.system),
        settingSources: [],
        permissionMode: "dontAsk",
        persistSession: false,
        thinking: { type: "adaptive", display: "omitted" },
        ...(mcpServers ? { mcpServers } : {}),
        allowedTools: tools.map((t) => `mcp__${MCP_SERVER}__${t.name}`),
      },
    });

    try {
      for await (const message of queryIterator) {
        if (message.type === "result") {
          if (message.subtype === "success") {
            if (message.usage)
              options.onUsage?.(usageOf(message.usage, contextWindow));
            if (ctx.stop) {
              emitStopText();
            } else if (!segments.length && message.result.trim()) {
              emit(message.result);
            }
            return segments;
          }
          throw new Error(`LocalClient query failed: ${message.subtype}`);
        }
        if (ctx.stop) {
          emitStopText();
          continue;
        }
        if (message.type === "system" && message.subtype === "init") {
          this.sessionIds.push(message.session_id);
        }
        if (message.type === "assistant") {
          const content = (message.message?.content ?? []) as {
            type: string;
            text?: string;
          }[];
          const text = content
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n");
          emit(text);
        }
      }
    } finally {
      if (queryIterator.return) {
        await queryIterator.return();
      }
    }
    throw new Error("LocalClient query ended without a result message");
  }

  async destroy(): Promise<void> {}
}
