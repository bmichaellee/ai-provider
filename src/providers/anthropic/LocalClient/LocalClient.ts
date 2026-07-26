import { DEFAULT_MODEL, contextWindowFor } from "../types";
import { contextUsageOf, turnUsageOf, usableWindow } from "../usage";
import type { RawUsage } from "../usage";
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
import { RefusalError } from "../../../errors";

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

type SdkUsage = RawUsage;

const localUsageOf = (
  usage: SdkUsage,
  contextWindow: number,
  iteration: number,
): ContextUsage =>
  contextUsageOf(usage, {
    contextWindow,
    iteration,
    providerKind: "local",
    sessionOverheadTokens: LOCAL_SESSION_OVERHEAD_TOKENS,
  });

type SdkModelUsage = Record<string, { contextWindow?: number }>;

const localTurnUsageOf = (
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
  return turnUsageOf(usage, {
    iterationCount,
    // The SDK's figure wins when it is usable, since it reflects the session
    // the turn actually ran in; a zero or NaN falls back to the catalog.
    contextWindow: usableWindow(entry?.contextWindow) ?? fallbackWindow,
    providerKind: "local",
    ...(costUSD === undefined ? {} : { costUSD }),
    sessionOverheadTokens: LOCAL_SESSION_OVERHEAD_TOKENS,
  });
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
    const contextWindow = contextWindowFor(model);
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

    let refusal: {
      category: string | null;
      explanation: string | null;
      model?: string;
    } | null = null;
    const refusalError = () =>
      new RefusalError({
        providerKind: "local",
        // Prefer the model the session reports having run: without an
        // explicit model the CLI picks its own default, and naming the
        // package's default here would describe a model that never ran.
        model: refusal?.model ?? options.model ?? model,
        category: refusal?.category ?? null,
        explanation: refusal?.explanation ?? null,
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
      uuid: string | undefined;
      texts: string[];
      builtins: { name: string; id: string }[];
    } | null = null;
    // Text already emitted, keyed by the frame that produced it, so a later
    // retraction can take it back out of the returned segments.
    const emittedByUuid = new Map<string, string>();
    const flushGroup = () => {
      if (!group) return;
      const text = group.texts.join("\n");
      const uuid = group.uuid;
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
        const before = segments.length;
        emit(text);
        if (uuid && segments.length > before) emittedByUuid.set(uuid, text);
      }
      group = null;
    };

    /**
     * Drop content the harness has voided. When a refusal is retried on a
     * fallback model, the refused leg's partial answer is retracted and
     * replaced — without this it would be flushed into segments and prefixed
     * to the retry's real answer. Text still buffered is dropped before it is
     * ever emitted; text already emitted is removed from the returned
     * segments. An onText callback that already fired cannot be recalled, so
     * consumers rendering the stream live should treat a retraction-carrying
     * frame as replacing what came before it.
     */
    const retract = (uuids: string[]) => {
      for (const uuid of uuids) {
        if (group?.uuid === uuid) {
          group = null;
          continue;
        }
        const text = emittedByUuid.get(uuid);
        if (text === undefined) continue;
        const at = segments.lastIndexOf(text);
        if (at !== -1) segments.splice(at, 1);
        emittedByUuid.delete(uuid);
      }
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
                localTurnUsageOf(
                  message.usage,
                  (message as { num_turns?: number }).num_turns ?? iteration,
                  contextWindow,
                  model,
                  (message as { modelUsage?: SdkModelUsage }).modelUsage,
                  (message as { total_cost_usd?: number }).total_cost_usd,
                ),
              );
            // Turn usage is reported first, then the refusal is raised: the
            // spend happened whether or not the model answered.
            const stopReason = (message as { stop_reason?: string | null })
              .stop_reason;
            if (refusal || stopReason === "refusal") throw refusalError();
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
        if (message.type === "system") {
          if (message.subtype === "init") this.sessionIds.push(message.session_id);
          // A refusal the harness could not retry ends the turn. Its sibling
          // "model_refusal_fallback" means the retry ran and succeeded, so it
          // is not a failure — but the refused leg's partial answer is
          // retracted, and must not reach the caller alongside the retry's.
          // Both subtypes are absent on older CLIs, which is why the result's
          // stop_reason is also checked.
          if (message.subtype === "model_refusal_fallback") {
            const retracted = (message as { retracted_message_uuids?: string[] })
              .retracted_message_uuids;
            if (retracted?.length) retract(retracted);
          }
          if (message.subtype === "model_refusal_no_fallback") {
            const refused = message as {
              api_refusal_category?: string | null;
              api_refusal_explanation?: string | null;
              original_model?: string;
            };
            refusal = {
              category: refused.api_refusal_category ?? null,
              explanation: refused.api_refusal_explanation ?? null,
              // The model that actually ran and refused, which is not
              // necessarily the one asked for: with no explicit model the
              // session runs the CLI's default.
              model: refused.original_model,
            };
          }
        }
        if (message.type === "assistant") {
          const api = message.message ?? {};
          const content = (api.content ?? []) as SdkContentBlock[];
          const apiId = (api as { id?: string }).id;
          // Retract before flushing: this frame replaces the ones it names,
          // and their text must never reach the caller.
          const supersedes = (message as { supersedes?: string[] }).supersedes;
          if (supersedes?.length) retract(supersedes);
          if (group && (group.id === undefined || group.id !== apiId))
            flushGroup();
          if (!group)
            group = {
              id: apiId,
              uuid: (message as { uuid?: string }).uuid,
              texts: [],
              builtins: [],
            };

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
            options.onUsage?.(localUsageOf(usage, contextWindow, iteration));
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
    // A refused turn can end without a result message at all; report the
    // refusal rather than the generic shape complaint.
    if (refusal) throw refusalError();
    throw new Error("LocalClient query ended without a result message");
  }

  async destroy(): Promise<void> {}
}
