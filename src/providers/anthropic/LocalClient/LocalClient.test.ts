import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  ProviderMessage,
  SendOptions,
  ToolContext,
  ToolSpec,
} from "../../../types";

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

const { LocalClient } = await import("./LocalClient");

const HI: ProviderMessage[] = [{ role: "user", content: "hi" }];

const send = (options?: SendOptions<any>, messages: ProviderMessage[] = HI) =>
  new LocalClient().sendMessage(messages, options);

const result = (
  subtype: string,
  text = "",
  usage?: Record<string, unknown>,
) => ({
  type: "result",
  subtype,
  result: text,
  ...(usage ? { usage } : {}),
});

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

const echoTool = (overrides: Partial<ToolSpec> = {}): ToolSpec => ({
  name: "echo",
  description: "echoes",
  schema: z.object({ value: z.string() }),
  run: async (input: any) => `echoed:${input.value}`,
  ...overrides,
});

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

  it("flattens the messages into a role-prefixed prompt", async () => {
    queryMessages = [result("success", "ok")];
    await send({}, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    expect(queryCalls[0].prompt).toBe("user: one\n\nassistant: two");
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

  it("flattens cache_control-bearing message blocks into the role-prefixed prompt", async () => {
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
    expect(queryCalls[0].prompt).toBe("user: hello");
  });

  it("asks the SDK to think adaptively but omit thinking from the output", async () => {
    queryMessages = [result("success", "ok")];
    await send();
    expect(queryCalls[0].options.thinking).toEqual({
      type: "adaptive",
      display: "omitted",
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

  it("reports context usage derived from the model's context window on a successful result", async () => {
    queryMessages = [
      result("success", "ok", {
        input_tokens: 100_000,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      }),
    ];
    const onUsage = vi.fn();
    await send({ model: "claude-haiku-4-5", onUsage });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100_000,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20,
      contextWindow: 200_000,
      percentUsed: 50,
    });
  });

  it("falls back to the default model's context window when none is specified", async () => {
    queryMessages = [
      result("success", "ok", {
        input_tokens: 500_000,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindow: 1_000_000, percentUsed: 50 }),
    );
  });

  it("captures usage from the result message even when a stop tool already fired, if the result is the very next message", async () => {
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
    const onUsage = vi.fn();
    await send({ tools: [stopTool], onUsage, model: "claude-haiku-4-5" });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100_000, contextWindow: 200_000 }),
    );
  });

  it("captures usage even when stray messages (e.g. the SDK's own tool-result echo) follow a stop tool before the terminal result", async () => {
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
    const onUsage = vi.fn();
    const streamed: string[] = [];
    const result_ = await send({
      tools: [stopTool],
      onUsage,
      onText: (s: string) => streamed.push(s),
      model: "claude-haiku-4-5",
    });
    expect(result_).toEqual(["here are your options"]);
    expect(streamed).toEqual(["here are your options"]);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100_000, contextWindow: 200_000 }),
    );
  });

  it("does not call onUsage when the result carries no usage data", async () => {
    queryMessages = [result("success", "ok")];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });
});

describe("LocalClient.destroy", () => {
  it("resolves without throwing", async () => {
    await expect(new LocalClient().destroy()).resolves.toBeUndefined();
  });
});
