import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProviderMessage,
  SendOptions,
  ToolContext,
  ToolSpec,
} from "../../../types";
import { echoTool } from "../../../testing/tools";
import { ClaudeModels } from "../types";

let queryMessages: any[] = [];
const queryCalls: any[] = [];
let queryReturned = false;
const sdkTools: Array<{
  name: string;
  description: string;
  shape: unknown;
  handler: (args: any) => Promise<any>;
}> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    queryCalls.push(opts);
    queryReturned = false;
    const messages = [...queryMessages];
    async function* gen() {
      for (const m of messages) {
        if (m.type === "__runTool") {
          await sdkTools[m.index ?? 0].handler(m.args ?? {});
          continue;
        }
        yield m;
      }
    }
    const iterator = gen();
    return {
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      return: async () => {
        queryReturned = true;
        return { value: undefined, done: true };
      },
    };
  },
  createSdkMcpServer: (config: any) => ({ __server: config }),
  tool: (
    name: string,
    description: string,
    shape: unknown,
    handler: (args: any) => Promise<any>,
  ) => {
    sdkTools.push({ name, description, shape, handler });
    return { name, description, shape, handler };
  },
}));

const { LOCAL_SESSION_OVERHEAD_TOKENS, LocalClient, TRANSCRIPT_INSTRUCTION } =
  await import("./LocalClient");

const HI: ProviderMessage[] = [{ role: "user", content: "hi" }];

const send = (options?: SendOptions<any>, messages: ProviderMessage[] = HI) =>
  new LocalClient().sendMessage(messages, options);

const result = (
  subtype: string,
  text = "",
  usage?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: "result",
  subtype,
  result: text,
  ...(usage ? { usage } : {}),
  ...extra,
});

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

const assistantWith = (
  blocks: unknown[],
  opts: { usage?: Record<string, unknown>; id?: string; parent?: string } = {},
) => ({
  type: "assistant",
  ...(opts.parent ? { parent_tool_use_id: opts.parent } : {}),
  message: {
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.usage ? { usage: opts.usage } : {}),
    content: blocks,
  },
});

const userWith = (blocks: unknown[]) => ({
  type: "user",
  message: { content: blocks },
});

const textBlock = (text: string) => ({ type: "text", text });

const toolUse = (id: string, name: string, input: unknown = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});

const toolResult = (
  tool_use_id: string,
  content: unknown,
  is_error?: boolean,
) => ({
  type: "tool_result",
  tool_use_id,
  content,
  ...(is_error ? { is_error } : {}),
});

const search = (id = "tu1") =>
  toolUse(id, "WebSearch", { query: "solar flares" });


const registerTool = async (spec: ToolSpec, options: SendOptions<any> = {}) => {
  queryMessages = [result("success", "ok")];
  await send({ ...options, tools: [spec] });
  return sdkTools[0].handler;
};

afterEach(() => {
  queryMessages = [];
  queryCalls.length = 0;
  sdkTools.length = 0;
  queryReturned = false;
});

describe("LocalClient.sendMessage", () => {
  it("returns the assistant text segments on a successful query", async () => {
    queryMessages = [assistant("the answer"), result("success", "the answer")];
    expect(await send()).toEqual(["the answer"]);
  });

  it("streams each assistant turn as its own segment and skips the duplicated result", async () => {
    queryMessages = [
      assistant("one moment"),
      assistant("all done"),
      result("success", "all done"),
    ];
    const streamed: string[] = [];
    expect(await send({ onText: (s: string) => streamed.push(s) })).toEqual([
      "one moment",
      "all done",
    ]);
    expect(streamed).toEqual(["one moment", "all done"]);
  });

  it("stops the turn when a tool sets ctx.stop, dropping any later model text", async () => {
    const stopTool = echoTool({
      name: "present_choice",
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "stopped";
      },
    });
    queryMessages = [
      assistant("the question"),
      { type: "__runTool", index: 0, args: {} },
      assistant("stray meta line after the tool"),
      result("success", "stray meta line after the tool"),
    ];
    const streamed: string[] = [];
    expect(
      await send({
        tools: [stopTool],
        onText: (s: string) => streamed.push(s),
      }),
    ).toEqual(["the question"]);
    expect(streamed).toEqual(["the question"]);
  });

  it("preserves same-message text buffered before an MCP stop tool fires", async () => {
    const stopTool = echoTool({
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "stopped";
      },
    });
    queryMessages = [
      assistantWith(
        [
          textBlock("the question"),
          toolUse("t1", "mcp__tools__echo", { value: "x" }),
        ],
        { id: "m1" },
      ),
      { type: "__runTool", index: 0, args: { value: "x" } },
      result("success", "the question"),
    ];
    const streamed: string[] = [];
    expect(
      await send({
        tools: [stopTool],
        onText: (s: string) => streamed.push(s),
      }),
    ).toEqual(["the question"]);
    expect(streamed).toEqual(["the question"]);
  });

  it("yields no segments when a tool stops the turn with no text and no stopText is configured", async () => {
    const stopTool = echoTool({
      name: "disengage",
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "disengaged";
      },
    });
    queryMessages = [
      { type: "__runTool", index: 0, args: {} },
      assistant("stray meta line after the tool"),
      result("success", "stray meta line after the tool"),
    ];
    expect(await send({ tools: [stopTool] })).toEqual([]);
  });

  it("falls back to the configured stopText when a tool stops the turn with no text", async () => {
    const stopTool = echoTool({
      name: "disengage",
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "disengaged";
      },
    });
    queryMessages = [
      { type: "__runTool", index: 0, args: {} },
      assistant("stray meta line after the tool"),
      result("success", "stray meta line after the tool"),
    ];
    expect(
      await send({ tools: [stopTool], stopText: "[The Weaver disengages.]" }),
    ).toEqual(["[The Weaver disengages.]"]);
  });

  it("does not emit stopText when the stopped turn already produced text", async () => {
    const stopTool = echoTool({
      name: "present_choice",
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "stopped";
      },
    });
    queryMessages = [
      assistant("the question"),
      { type: "__runTool", index: 0, args: {} },
      result("success", "the question"),
    ];
    expect(await send({ tools: [stopTool], stopText: "[gone]" })).toEqual([
      "the question",
    ]);
  });

  it("keeps same-message pre-stop text instead of replacing it with stopText", async () => {
    const stopTool = echoTool({
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "stopped";
      },
    });
    queryMessages = [
      assistantWith(
        [
          textBlock("the question"),
          toolUse("t1", "mcp__tools__echo", { value: "x" }),
        ],
        { id: "m1" },
      ),
      { type: "__runTool", index: 0, args: { value: "x" } },
      result("success", "the question"),
    ];
    expect(await send({ tools: [stopTool], stopText: "[gone]" })).toEqual([
      "the question",
    ]);
  });

  it("hands the app context to tools as ctx.app", async () => {
    const seen: unknown[] = [];
    const peek = echoTool({
      name: "peek",
      run: async (_input: any, ctx?: ToolContext) => {
        seen.push(ctx?.app);
        return "peeked";
      },
    });
    const handler = await registerTool(peek, {
      context: { tag: "game-state" },
    });
    await handler({});
    expect(seen).toEqual([{ tag: "game-state" }]);
  });

  it("sends a single user message as bare content with no role prefix or instruction", async () => {
    queryMessages = [result("success", "ok")];
    await send({}, [{ role: "user", content: "one" }]);
    expect(queryCalls[0].prompt).toBe("one");
    expect(queryCalls[0].options.systemPrompt).toBeUndefined();
  });

  it("sends a multi-message conversation as a closed transcript with the standing instruction", async () => {
    queryMessages = [result("success", "ok")];
    await send({}, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    expect(queryCalls[0].prompt).toBe(
      '<conversation-transcript>\n<turn role="user">\none\n</turn>\n<turn role="assistant">\ntwo\n</turn>\n</conversation-transcript>',
    );
    expect(queryCalls[0].options.systemPrompt).toBe(TRANSCRIPT_INSTRUCTION);
  });

  it("appends the standing instruction after the consumer system prompt on transcripts", async () => {
    queryMessages = [result("success", "ok")];
    await send({ system: "be the weaver" }, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    expect(queryCalls[0].options.systemPrompt).toEqual([
      "be the weaver",
      TRANSCRIPT_INSTRUCTION,
    ]);
  });

  it("flattens cache_control-bearing system blocks into a plain string prompt, ignoring the cache hints", async () => {
    queryMessages = [result("success", "ok")];
    await send({
      system: [
        {
          type: "text",
          text: "stable",
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: " and live" },
      ],
    });
    expect(queryCalls[0].options.systemPrompt).toBe("stable and live");
  });

  it("flattens cache_control-bearing message blocks into the bare prompt", async () => {
    queryMessages = [result("success", "ok")];
    await send({}, [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(queryCalls[0].prompt).toBe("hello");
  });

  it("asks the SDK to think adaptively but omit thinking when nobody is listening", async () => {
    queryMessages = [result("success", "ok")];
    await send();
    expect(queryCalls[0].options.thinking).toEqual({
      type: "adaptive",
      display: "omitted",
    });
  });

  it("asks for summarized thinking when a consumer registers onThinking", async () => {
    queryMessages = [result("success", "ok")];
    await send({ onThinking: () => {} });
    // Set explicitly rather than left unset: the install's own
    // --thinking-display default would otherwise decide, making the same
    // call behave differently on two machines.
    expect(queryCalls[0].options.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("does not set an effort level when none is provided", async () => {
    queryMessages = [result("success", "ok")];
    await send();
    expect(queryCalls[0].options.effort).toBeUndefined();
  });

  it("passes a provided effort level to the SDK", async () => {
    queryMessages = [result("success", "ok")];
    await send({ effort: "high" });
    expect(queryCalls[0].options.effort).toBe("high");
  });

  it("passes the requested model to the SDK", async () => {
    queryMessages = [result("success", "ok")];
    await send({ model: ClaudeModels.Opus });
    expect(queryCalls[0].options.model).toBe(ClaudeModels.Opus);
  });

  it("leaves the model unset so the session default applies when none is given", async () => {
    queryMessages = [result("success", "ok")];
    await send();
    expect(queryCalls[0].options.model).toBeUndefined();
  });

  it("does not configure MCP servers when there are no tools", async () => {
    queryMessages = [result("success", "ok")];
    await send();
    expect(queryCalls[0].options.mcpServers).toBeUndefined();
    expect(queryCalls[0].options.allowedTools).toEqual([]);
  });

  it("registers tools as an MCP server and allows them by qualified name", async () => {
    await registerTool(echoTool());
    expect(queryCalls[0].options.mcpServers).toBeDefined();
    expect(queryCalls[0].options.allowedTools).toEqual(["mcp__tools__echo"]);
    expect(sdkTools).toHaveLength(1);
    expect(sdkTools[0].name).toBe("echo");
  });

  it("wraps a tool so its output becomes SDK text content", async () => {
    const handler = await registerTool(echoTool());
    expect(await handler({ value: "world" })).toEqual({
      content: [{ type: "text", text: "echoed:world" }],
    });
  });

  it("wraps a throwing tool as an SDK error result", async () => {
    const handler = await registerTool(
      echoTool({
        run: async () => {
          throw new Error("kaboom");
        },
      }),
    );
    expect(await handler({ value: "x" })).toEqual({
      content: [{ type: "text", text: "kaboom" }],
      isError: true,
    });
  });

  it("stringifies a non-Error thrown by a tool", async () => {
    const handler = await registerTool(
      echoTool({
        run: async () => {
          throw "plain string";
        },
      }),
    );
    expect(await handler({ value: "x" })).toEqual({
      content: [{ type: "text", text: "plain string" }],
      isError: true,
    });
  });

  it("throws when the query result subtype is not success", async () => {
    queryMessages = [result("error_max_turns")];
    await expect(send()).rejects.toThrow(/query failed: error_max_turns/);
  });

  it("throws when the query ends without a result message", async () => {
    queryMessages = [{ type: "assistant" }];
    await expect(send()).rejects.toThrow(/ended without a result message/);
  });

  it("closes the query iterator when finished", async () => {
    queryMessages = [result("success", "ok")];
    await send();
    expect(queryReturned).toBe(true);
  });

  it("closes the query iterator even when the result subtype fails", async () => {
    queryMessages = [result("error_during_execution")];
    await expect(send()).rejects.toThrow();
    expect(queryReturned).toBe(true);
  });

  it("reports per-call usage from each assistant message, honestly sized to that call", async () => {
    queryMessages = [
      assistantWith([textBlock("one")], {
        id: "m1",
        usage: {
          input_tokens: 99_980,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 10,
        },
      }),
      assistantWith([textBlock("two")], {
        id: "m2",
        usage: {
          input_tokens: 149_990,
          output_tokens: 60,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
      }),
      result("success", "two"),
    ];
    const onUsage = vi.fn();
    await send({ model: "claude-haiku-4-5", onUsage });
    expect(onUsage).toHaveBeenNthCalledWith(1, {
      inputTokens: 99_980,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 10,
      contextWindow: 200_000,
      percentUsed: 50,
      iteration: 1,
      providerKind: "local",
      sessionOverheadTokens: LOCAL_SESSION_OVERHEAD_TOKENS,
    });
    expect(onUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ iteration: 2, percentUsed: 75 }),
    );
  });

  it("normalizes null cache fields on per-call usage to zero", async () => {
    queryMessages = [
      assistantWith([textBlock("ok")], {
        usage: {
          input_tokens: 1000,
          output_tokens: 5,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      }),
      result("success", "ok"),
    ];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    );
  });

  it("reports usage once per API call when the SDK splits it across messages sharing an id", async () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    queryMessages = [
      assistantWith([textBlock("part one")], { id: "m1", usage }),
      assistantWith([textBlock("part two")], { id: "m1", usage }),
      result("success", "part two"),
    ];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ iteration: 1 }),
    );
  });

  it("skips usage from subagent assistant messages so the window reading stays the main thread's", async () => {
    queryMessages = [
      assistantWith([textBlock("subagent chatter")], {
        id: "s1",
        parent: "tu1",
        usage: {
          input_tokens: 42,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      result("success", "done"),
    ];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("falls back to the default model's context window when none is specified", async () => {
    queryMessages = [
      assistantWith([textBlock("ok")], {
        usage: {
          input_tokens: 500_000,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      result("success", "ok"),
    ];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindow: 1_000_000, percentUsed: 50 }),
    );
  });

  it("does not route the cumulative result usage through onUsage", async () => {
    queryMessages = [
      result("success", "ok", {
        input_tokens: 100_000,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      }),
    ];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("reports turn totals via onTurnUsage from the result message", async () => {
    queryMessages = [
      assistant("ok"),
      result(
        "success",
        "ok",
        {
          input_tokens: 995_000,
          output_tokens: 4_000,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 3_000,
        },
        {
          num_turns: 12,
          total_cost_usd: 1.25,
          modelUsage: { "claude-haiku-4-5": { contextWindow: 200_000 } },
        },
      ),
    ];
    const onTurnUsage = vi.fn();
    await send({ model: "claude-haiku-4-5", onTurnUsage });
    expect(onTurnUsage).toHaveBeenCalledTimes(1);
    expect(onTurnUsage).toHaveBeenCalledWith({
      inputTokens: 995_000,
      outputTokens: 4_000,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 3_000,
      iterationCount: 12,
      contextWindow: 200_000,
      costUSD: 1.25,
      providerKind: "local",
      sessionOverheadTokens: LOCAL_SESSION_OVERHEAD_TOKENS,
    });
  });

  it("takes the turn context window from the sole modelUsage entry when its key differs", async () => {
    queryMessages = [
      result(
        "success",
        "ok",
        {
          input_tokens: 1000,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        {
          modelUsage: { "claude-haiku-4-5-20251001": { contextWindow: 200_000 } },
        },
      ),
    ];
    const onTurnUsage = vi.fn();
    await send({ onTurnUsage });
    expect(onTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindow: 200_000 }),
    );
  });

  it("ignores an unusable provider-reported window in favour of the model map", async () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    for (const unusable of [0, Number.NaN, -1]) {
      queryMessages = [
        result("success", "ok", usage, {
          modelUsage: { "claude-haiku-4-5": { contextWindow: unusable } },
        }),
      ];
      const onTurnUsage = vi.fn();
      await send({ model: "claude-haiku-4-5", onTurnUsage });
      expect(onTurnUsage).toHaveBeenCalledWith(
        expect.objectContaining({ contextWindow: 200_000 }),
      );
      queryCalls.length = 0;
    }
  });

  it("falls back to the model map window and counted iterations when the result is bare", async () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    queryMessages = [
      assistantWith([textBlock("one")], { id: "m1", usage }),
      assistantWith([textBlock("two")], { id: "m2", usage }),
      result("success", "two", usage),
    ];
    const onTurnUsage = vi.fn();
    await send({ onTurnUsage });
    expect(onTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindow: 1_000_000, iterationCount: 2 }),
    );
    expect(onTurnUsage.mock.calls[0][0]).not.toHaveProperty("costUSD");
  });

  it("captures turn totals even when a stop tool already fired, if the result is the very next message", async () => {
    const stopTool = echoTool({
      name: "present_choice",
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "choices presented";
      },
    });
    queryMessages = [
      assistant("here are your options"),
      { type: "__runTool", index: 0, args: {} },
      result("success", "here are your options", {
        input_tokens: 100_000,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const onTurnUsage = vi.fn();
    await send({ tools: [stopTool], onTurnUsage, model: "claude-haiku-4-5" });
    expect(onTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100_000, contextWindow: 200_000 }),
    );
  });

  it("captures turn totals even when stray messages (e.g. the SDK's own tool-result echo) follow a stop tool before the terminal result", async () => {
    const stopTool = echoTool({
      name: "present_choice",
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "choices presented";
      },
    });
    queryMessages = [
      assistant("here are your options"),
      { type: "__runTool", index: 0, args: {} },
      { type: "user" },
      assistant("a stray trailing turn that must not reach the client"),
      result("success", "here are your options", {
        input_tokens: 100_000,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const onTurnUsage = vi.fn();
    const streamed: string[] = [];
    const result_ = await send({
      tools: [stopTool],
      onTurnUsage,
      onText: (s: string) => streamed.push(s),
      model: "claude-haiku-4-5",
    });
    expect(result_).toEqual(["here are your options"]);
    expect(streamed).toEqual(["here are your options"]);
    expect(onTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100_000, contextWindow: 200_000 }),
    );
  });

  it("calls neither usage callback when the stream carries no usage data", async () => {
    queryMessages = [assistant("ok"), result("success", "ok")];
    const onUsage = vi.fn();
    const onTurnUsage = vi.fn();
    await send({ onUsage, onTurnUsage });
    expect(onUsage).not.toHaveBeenCalled();
    expect(onTurnUsage).not.toHaveBeenCalled();
  });
});

describe("LocalClient tool activity", () => {
  const collect = () => {
    const events: any[] = [];
    return { events, onToolActivity: (a: any) => events.push(a) };
  };

  it("fires a start activity for a built-in tool_use with a one-line input summary", async () => {
    queryMessages = [assistantWith([search()]), result("success", "done")];
    const { events, onToolActivity } = collect();
    await send({ onToolActivity });
    expect(events).toEqual([
      {
        phase: "start",
        toolName: "WebSearch",
        toolUseId: "tu1",
        summary: 'WebSearch: {"query":"solar flares"}',
        detail: '{"query":"solar flares"}',
      },
    ]);
  });

  it("fires an end activity correlated by tool_use_id when the result arrives", async () => {
    queryMessages = [
      assistantWith([search()]),
      userWith([toolResult("tu1", "flare imminent")]),
      result("success", "done"),
    ];
    const { events, onToolActivity } = collect();
    await send({ onToolActivity });
    expect(events[1]).toEqual({
      phase: "end",
      toolName: "WebSearch",
      toolUseId: "tu1",
      summary: "WebSearch: flare imminent",
      detail: "flare imminent",
    });
  });

  it("marks an errored tool result and prefixes its summary", async () => {
    queryMessages = [
      assistantWith([search()]),
      userWith([toolResult("tu1", "rate limited", true)]),
      result("success", "done"),
    ];
    const { events, onToolActivity } = collect();
    await send({ onToolActivity });
    expect(events[1]).toMatchObject({
      phase: "end",
      isError: true,
      summary: "WebSearch: error: rate limited",
    });
  });

  it("flattens block-array tool_result content", async () => {
    queryMessages = [
      assistantWith([search()]),
      userWith([
        toolResult("tu1", [textBlock("line one"), textBlock("line two")]),
      ]),
      result("success", "done"),
    ];
    const { events, onToolActivity } = collect();
    await send({ onToolActivity });
    expect(events[1]).toMatchObject({
      summary: "WebSearch: line one line two",
      detail: "line one\nline two",
    });
  });

  it("stays silent for the app's own MCP tools", async () => {
    queryMessages = [
      assistantWith([toolUse("tu9", "mcp__tools__echo", { value: "x" })]),
      userWith([toolResult("tu9", "echoed:x")]),
      result("success", "done"),
    ];
    const { events, onToolActivity } = collect();
    await send({ tools: [echoTool()], onToolActivity });
    expect(events).toEqual([]);
  });

  it("truncates a long input to a single-line summary but keeps full detail", async () => {
    const long = "b".repeat(200);
    queryMessages = [
      assistantWith([toolUse("tu1", "Bash", { command: long })]),
      result("success", "done"),
    ];
    const { events, onToolActivity } = collect();
    await send({ onToolActivity });
    expect(events[0].detail).toBe(JSON.stringify({ command: long }));
    expect(events[0].summary.endsWith("…")).toBe(true);
    expect(events[0].summary.length).toBeLessThanOrEqual(
      "Bash: ".length + 121,
    );
  });

  it("keeps reporting activity after a stop tool fires", async () => {
    const stopTool = echoTool({
      name: "disengage",
      run: async (_input: any, ctx?: ToolContext) => {
        if (ctx) ctx.stop = true;
        return "disengaged";
      },
    });
    queryMessages = [
      { type: "__runTool", index: 0, args: {} },
      assistantWith([search()]),
      userWith([toolResult("tu1", "late result")]),
      result("success", ""),
    ];
    const { events, onToolActivity } = collect();
    await send({ tools: [stopTool], onToolActivity });
    expect(events.map((e) => e.phase)).toEqual(["start", "end"]);
  });
});

describe("LocalClient interstitial commentary", () => {
  it("diverts text sharing a message with built-in tool calls out of the transcript", async () => {
    queryMessages = [
      assistantWith([textBlock("let the search finish"), search()]),
      assistant("the real reply"),
      result("success", "the real reply"),
    ];
    const events: any[] = [];
    const streamed: string[] = [];
    const segments = await send({
      onText: (s: string) => streamed.push(s),
      onToolActivity: (a: any) => events.push(a),
    });
    expect(segments).toEqual(["the real reply"]);
    expect(streamed).toEqual(["the real reply"]);
    expect(events).toContainEqual({
      phase: "commentary",
      toolName: "WebSearch",
      toolUseId: "tu1",
      summary: "let the search finish",
      detail: "let the search finish",
    });
  });

  it("diverts commentary split across SDK messages sharing an API message id", async () => {
    queryMessages = [
      assistantWith([textBlock("let me look that up")], { id: "m1" }),
      assistantWith([search()], { id: "m1" }),
      assistant("the real reply"),
      result("success", "the real reply"),
    ];
    const events: any[] = [];
    const streamed: string[] = [];
    const segments = await send({
      onText: (s: string) => streamed.push(s),
      onToolActivity: (a: any) => events.push(a),
    });
    expect(segments).toEqual(["the real reply"]);
    expect(streamed).toEqual(["the real reply"]);
    expect(events).toContainEqual({
      phase: "commentary",
      toolName: "WebSearch",
      toolUseId: "tu1",
      summary: "let me look that up",
      detail: "let me look that up",
    });
  });

  it("keeps a split API message grouped across interleaved informational events", async () => {
    queryMessages = [
      assistantWith([textBlock("let me look that up")], { id: "m1" }),
      { type: "rate_limit_event" },
      assistantWith([search()], { id: "m1" }),
      userWith([toolResult("tu1", "found it")]),
      assistant("the real reply"),
      result("success", "the real reply"),
    ];
    const events: any[] = [];
    const segments = await send({ onToolActivity: (a: any) => events.push(a) });
    expect(segments).toEqual(["the real reply"]);
    expect(events.map((e) => e.phase)).toEqual(["start", "commentary", "end"]);
  });

  it("emits buffered text once its API message completes without tool calls", async () => {
    queryMessages = [
      assistantWith([textBlock("part one")], { id: "m1" }),
      assistantWith([textBlock("part two")], { id: "m1" }),
      assistantWith([textBlock("next call")], { id: "m2" }),
      result("success", "next call"),
    ];
    expect(await send()).toEqual(["part one\npart two", "next call"]);
  });

  it("still emits text that accompanies only the app's MCP tools", async () => {
    queryMessages = [
      assistantWith([
        textBlock("choosing"),
        toolUse("t1", "mcp__tools__echo", { value: "x" }),
      ]),
      result("success", "done"),
    ];
    const streamed: string[] = [];
    expect(
      await send({ tools: [echoTool()], onText: (s: string) => streamed.push(s) }),
    ).toEqual(["choosing"]);
    expect(streamed).toEqual(["choosing"]);
  });

  it("drops commentary from the transcript even when no activity callback is registered", async () => {
    queryMessages = [
      assistantWith([textBlock("let the search finish"), search()]),
      assistant("the real reply"),
      result("success", "the real reply"),
    ];
    expect(await send()).toEqual(["the real reply"]);
  });

  it("returns no segments for a commentary-only turn instead of re-leaking via the result fallback", async () => {
    queryMessages = [
      assistantWith([textBlock("working on it"), search()]),
      result("success", "working on it"),
    ];
    const streamed: string[] = [];
    expect(await send({ onText: (s: string) => streamed.push(s) })).toEqual([]);
    expect(streamed).toEqual([]);
  });
});

describe("LocalClient thinking", () => {
  const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking });

  it("delivers thinking to onThinking and keeps it out of the segments", async () => {
    queryMessages = [
      assistantWith([thinkingBlock("weighing it up"), textBlock("the answer")]),
      result("success", "the answer"),
    ];
    const thoughts: string[] = [];
    const segments = await send({
      onThinking: (segment) => thoughts.push(segment),
    });
    expect(thoughts).toEqual(["weighing it up"]);
    expect(segments).toEqual(["the answer"]);
  });

  it("keeps thinking out of onText", async () => {
    queryMessages = [
      assistantWith([thinkingBlock("weighing it up"), textBlock("the answer")]),
      result("success", "the answer"),
    ];
    const streamed: string[] = [];
    await send({
      onText: (segment) => streamed.push(segment),
      onThinking: () => {},
    });
    expect(streamed).toEqual(["the answer"]);
  });

  it("reports thinking before the text it preceded, which is buffered until its message completes", async () => {
    queryMessages = [
      assistantWith([thinkingBlock("weighing it up"), textBlock("the answer")]),
      result("success", "the answer"),
    ];
    const events: string[] = [];
    await send({
      onText: (segment) => events.push(`text:${segment}`),
      onThinking: (segment) => events.push(`thinking:${segment}`),
    });
    expect(events).toEqual(["thinking:weighing it up", "text:the answer"]);
  });

  it("routes thinking to onThinking, not to the tool commentary channel it shares a message with", async () => {
    queryMessages = [
      assistantWith([thinkingBlock("search first"), search()]),
      assistant("the real reply"),
      result("success", "the real reply"),
    ];
    const thoughts: string[] = [];
    const activity: any[] = [];
    await send({
      onThinking: (segment) => thoughts.push(segment),
      onToolActivity: (event) => activity.push(event),
    });
    expect(thoughts).toEqual(["search first"]);
    expect(activity.map((event) => event.phase)).toEqual(["start"]);
  });

  it("skips subagent thinking so the stream stays this conversation's reasoning", async () => {
    queryMessages = [
      assistantWith([thinkingBlock("subagent musing")], {
        id: "s1",
        parent: "tu1",
      }),
      assistant("the answer"),
      result("success", "the answer"),
    ];
    const onThinking = vi.fn();
    await send({ onThinking });
    expect(onThinking).not.toHaveBeenCalled();
  });

  it("stays silent on the empty thinking blocks an omitted display returns", async () => {
    queryMessages = [
      assistantWith([thinkingBlock(""), textBlock("the answer")]),
      result("success", "the answer"),
    ];
    const onThinking = vi.fn();
    await send({ onThinking });
    expect(onThinking).not.toHaveBeenCalled();
  });

  it("drops thinking from the segments even with no listener registered", async () => {
    queryMessages = [
      assistantWith([thinkingBlock("weighing it up"), textBlock("the answer")]),
      result("success", "the answer"),
    ];
    expect(await send()).toEqual(["the answer"]);
  });
});

describe("LOCAL_SESSION_OVERHEAD_TOKENS", () => {
  it("stays within the range its documentation claims to have measured", () => {
    // Every other assertion compares against the constant itself, so they
    // hold for any value — including zero, which would silently turn the
    // documented `contextWindow - sessionOverheadTokens` budget into a no-op.
    // This one pins the magnitude the docstring and README both promise.
    expect(LOCAL_SESSION_OVERHEAD_TOKENS).toBeGreaterThanOrEqual(60_000);
    expect(LOCAL_SESSION_OVERHEAD_TOKENS).toBeLessThanOrEqual(75_000);
  });
});

describe("LocalClient refusals", () => {
  const refusalNotice = (
    subtype: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: "system",
    subtype,
    original_model: "claude-opus-5",
    content: "I can't help with that.",
    ...extra,
  });

  it("raises a refusal the harness could not retry", async () => {
    queryMessages = [
      refusalNotice("model_refusal_no_fallback", {
        api_refusal_category: "cyber",
        api_refusal_explanation: "declined",
      }),
      result("success", ""),
    ];
    await expect(send()).rejects.toMatchObject({
      name: "RefusalError",
      category: "cyber",
      explanation: "declined",
      providerKind: "local",
    });
  });

  it("names the model that actually ran, not the package default", async () => {
    queryMessages = [
      refusalNotice("model_refusal_no_fallback", {
        original_model: "claude-opus-5",
      }),
      result("success", ""),
    ];
    // No model requested, so the session picked its own — the error must name
    // that one rather than this package's default.
    await expect(send()).rejects.toMatchObject({ model: "claude-opus-5" });
  });

  it("raises a refusal reported only by the result's stop reason", async () => {
    queryMessages = [result("success", "", undefined, { stop_reason: "refusal" })];
    await expect(send()).rejects.toMatchObject({ name: "RefusalError" });
  });

  it("does not raise when the harness retried on a fallback model", async () => {
    queryMessages = [
      assistantWith([textBlock("the retry's answer")], { id: "m1" }),
      refusalNotice("model_refusal_fallback", {
        fallback_model: "claude-opus-4-8",
      }),
      result("success", "the retry's answer"),
    ];
    expect(await send()).toEqual(["the retry's answer"]);
  });

  it("withholds the refused leg's text when a superseding frame replaces it", async () => {
    queryMessages = [
      {
        ...assistantWith([textBlock("the refused partial")], { id: "m0" }),
        uuid: "u-refused",
      },
      {
        ...assistantWith([textBlock("the retry's answer")], { id: "m1" }),
        uuid: "u-retry",
        supersedes: ["u-refused"],
      },
      result("success", "the retry's answer"),
    ];
    const streamed: string[] = [];
    expect(await send({ onText: (s: string) => streamed.push(s) })).toEqual([
      "the retry's answer",
    ]);
    expect(streamed).not.toContain("the refused partial");
  });

  it("withholds retracted text named by the end-of-turn fallback notice", async () => {
    queryMessages = [
      {
        ...assistantWith([textBlock("the refused partial")], { id: "m0" }),
        uuid: "u-refused",
      },
      { ...assistantWith([textBlock("the retry's answer")], { id: "m1" }), uuid: "u-retry" },
      refusalNotice("model_refusal_fallback", {
        retracted_message_uuids: ["u-refused"],
      }),
      result("success", "the retry's answer"),
    ];
    expect(await send()).toEqual(["the retry's answer"]);
  });
});

describe("LocalClient.providerKind", () => {
  it('is "local"', () => {
    expect(new LocalClient().providerKind).toBe("local");
  });
});

describe("LocalClient.destroy", () => {
  it("resolves without throwing", async () => {
    await expect(new LocalClient().destroy()).resolves.toBeUndefined();
  });
});
