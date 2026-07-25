import { ClaudeContextWindow, DEFAULT_MODEL } from "../types";
import type {
  AIProvider,
  ContextUsage,
  MessageContent,
  ProviderMessage,
  SendOptions,
  SystemPrompt,
  ToolActivity,
  ToolContext,
  ToolSpec,
  TurnUsage,
} from "../../../types";
import { executeTool } from "../../../executeTool";

const MCP_SERVER = "tools";
const TOOL_PREFIX = `mcp__${MCP_SERVER}__`;

/**
 * Estimated tokens of Claude Code harness overhead (built-in tool schemas and
 * machinery) carried in every API call's context beyond app-supplied content.
 * Measured at 60,000–75,000 per iteration on Agent SDK 0.3.x; drifts with
 * Claude Code versions, so treat as ±10k when budgeting tightly.
 */
export const LOCAL_SESSION_OVERHEAD_TOKENS = 65_000;

export const TRANSCRIPT_INSTRUCTION =
  "The user prompt is a finished conversation transcript inside " +
  "<conversation-transcript> tags. Write only the next assistant turn: plain " +
  "reply text with no <turn> tags and no role labels. Never write, invent, or " +
  "answer a user turn; if the conversation needs user input, end your reply " +
  "and wait.";

const flattenText = (content: SystemPrompt | MessageContent): string =>
  typeof content === "string"
    ? content
    : content.map((block) => block.text).join("");

const isBareMessage = (messages: ProviderMessage[]): boolean =>
  messages.length === 1 && messages[0].role === "user";

const toPrompt = (messages: ProviderMessage[]): string => {
  if (isBareMessage(messages)) return flattenText(messages[0].content);
  return [
    "<conversation-transcript>",
    ...messages.map(
      (message) =>
        `<turn role="${message.role}">\n${flattenText(message.content)}\n</turn>`,
    ),
    "</conversation-transcript>",
  ].join("\n");
};

const oneLine = (text: string, max = 120): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
};

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
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

const usageOf = (
  usage: SdkUsage,
  contextWindow: number,
  iteration: number,
): ContextUsage => {
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
    providerKind: "local",
    sessionOverheadTokens: LOCAL_SESSION_OVERHEAD_TOKENS,
  };
};

type SdkModelUsage = Record<string, { contextWindow?: number }>;

const turnUsageOf = (
  usage: SdkUsage,
  iterationCount: number,
  fallbackWindow: number,
  model: string,
  modelUsage?: SdkModelUsage,
  costUSD?: number,
): TurnUsage => {
  const entries = modelUsage ? Object.entries(modelUsage) : [];
  const entry =
    modelUsage?.[model] ?? (entries.length === 1 ? entries[0][1] : undefined);
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    iterationCount,
    contextWindow: entry?.contextWindow ?? fallbackWindow,
    ...(costUSD === undefined ? {} : { costUSD }),
    providerKind: "local",
  };
};

type SdkContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
};

const resultText = (
  content: string | { type: string; text?: string }[],
): string =>
  typeof content === "string"
    ? content
    : content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");

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
  readonly providerKind = "local" as const;
  readonly sessionIds: string[] = [];

  async sendMessage<TApp = unknown>(
    messages: ProviderMessage[],
    options: SendOptions<TApp> = {},
  ): Promise<string[]> {
    const { query, tool, createSdkMcpServer } = await loadAgentSdk();

    const prompt = toPrompt(messages);
    const transcript = !isBareMessage(messages);
    const tools = options.tools ?? [];
    const model = options.model ?? DEFAULT_MODEL;
    const contextWindow = ClaudeContextWindow[model];
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
    const activity = (event: ToolActivity) => options.onToolActivity?.(event);

    const mcpServers = tools.length
      ? {
          [MCP_SERVER]: createSdkMcpServer({
            name: MCP_SERVER,
            version: "1.0.0",
            tools: tools.map((t) => toSdkTool(tool, t, ctx)),
          }),
        }
      : undefined;

    const consumerSystem =
      options.system === undefined ? undefined : flattenText(options.system);
    const systemPrompt = !transcript
      ? consumerSystem
      : consumerSystem === undefined
        ? TRANSCRIPT_INSTRUCTION
        : [consumerSystem, TRANSCRIPT_INSTRUCTION];

    const queryIterator = query({
      prompt,
      options: {
        model: options.model,
        ...(options.effort ? { effort: options.effort } : {}),
        systemPrompt,
        settingSources: [],
        permissionMode: "dontAsk",
        persistSession: false,
        thinking: { type: "adaptive", display: "omitted" },
        ...(mcpServers ? { mcpServers } : {}),
        allowedTools: tools.map((t) => `${TOOL_PREFIX}${t.name}`),
      },
    });

    // tool_use_id -> toolName, for built-in (non-MCP) tools awaiting results.
    const pendingTools = new Map<string, string>();
    const seenApiMessageIds = new Set<string>();
    let iteration = 0;
    let divertedCommentary = false;

    // The SDK splits one API message across several stream messages sharing
    // message.id — text in one, tool_use in the next. Whether text is content
    // or tool commentary is a property of the whole API message, so buffer
    // blocks per id and decide at flush.
    let group: {
      id: string | undefined;
      texts: string[];
      builtins: { name: string; id: string }[];
    } | null = null;
    const flushGroup = () => {
      if (!group) return;
      const text = group.texts.join("\n");
      if (group.builtins.length) {
        if (text.trim()) {
          divertedCommentary = true;
          activity({
            phase: "commentary",
            toolName: group.builtins[0].name,
            toolUseId: group.builtins[0].id,
            summary: oneLine(text),
            detail: text,
          });
        }
      } else if (!ctx.stop) {
        emit(text);
      }
      group = null;
    };

    try {
      for await (const message of queryIterator) {
        // Only messages that end an assistant API message may flush the
        // buffered group; informational events (system, rate_limit_event,
        // tool_progress, ...) interleave mid-message and must not.
        if (message.type === "user" || message.type === "result") flushGroup();
        if (message.type === "result") {
          if (message.subtype === "success") {
            if (message.usage)
              options.onTurnUsage?.(
                turnUsageOf(
                  message.usage,
                  (message as { num_turns?: number }).num_turns ?? iteration,
                  contextWindow,
                  model,
                  (message as { modelUsage?: SdkModelUsage }).modelUsage,
                  (message as { total_cost_usd?: number }).total_cost_usd,
                ),
              );
            if (ctx.stop) {
              emitStopText();
            } else if (
              !segments.length &&
              !divertedCommentary &&
              message.result.trim()
            ) {
              emit(message.result);
            }
            return segments;
          }
          throw new Error(`LocalClient query failed: ${message.subtype}`);
        }
        if (message.type === "system" && message.subtype === "init") {
          this.sessionIds.push(message.session_id);
        }
        if (message.type === "assistant") {
          const api = message.message ?? {};
          const content = (api.content ?? []) as SdkContentBlock[];
          const apiId = (api as { id?: string }).id;
          if (group && (group.id === undefined || group.id !== apiId))
            flushGroup();
          if (!group) group = { id: apiId, texts: [], builtins: [] };

          // Count and report usage once per API call, and only for the main
          // thread (subagent calls don't describe our window).
          const usage = (api as { usage?: SdkUsage }).usage;
          if (
            usage &&
            message.parent_tool_use_id == null &&
            (!apiId || !seenApiMessageIds.has(apiId))
          ) {
            if (apiId) seenApiMessageIds.add(apiId);
            iteration += 1;
            options.onUsage?.(usageOf(usage, contextWindow, iteration));
          }

          for (const block of content) {
            if (block.type === "text") {
              if (block.text) group.texts.push(block.text);
              continue;
            }
            if (block.type !== "tool_use") continue;
            if ((block.name ?? "").startsWith(TOOL_PREFIX)) continue;
            const toolName = block.name ?? "unknown";
            const toolUseId = block.id ?? "";
            const input = JSON.stringify(block.input ?? {});
            pendingTools.set(toolUseId, toolName);
            group.builtins.push({ name: toolName, id: toolUseId });
            activity({
              phase: "start",
              toolName,
              toolUseId,
              summary: `${toolName}: ${oneLine(input)}`,
              detail: input,
            });
          }

          // Without an id there is nothing to correlate later messages by.
          if (apiId === undefined) flushGroup();
        }
        if (message.type === "user") {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content as SdkContentBlock[]) {
              if (block.type !== "tool_result" || !block.tool_use_id) continue;
              const toolName = pendingTools.get(block.tool_use_id);
              if (!toolName) continue;
              pendingTools.delete(block.tool_use_id);
              const text = resultText(block.content ?? "");
              activity({
                phase: "end",
                toolName,
                toolUseId: block.tool_use_id,
                summary: `${toolName}: ${block.is_error ? "error: " : ""}${oneLine(text)}`,
                detail: text,
                ...(block.is_error ? { isError: true } : {}),
              });
            }
          }
        }
        if (ctx.stop) emitStopText();
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
