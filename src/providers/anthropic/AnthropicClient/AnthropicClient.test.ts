import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SendOptions, ToolSpec } from "../../../types";

let finalMessages: any[] = [];
const streamCalls: any[] = [];
const constructorArgs: any[] = [];

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      stream: (params: any) => {
        streamCalls.push(params);
        const message = finalMessages.shift();
        return { finalMessage: async () => message };
      },
    };
    constructor(...args: any[]) {
      constructorArgs.push(args);
    }
  }
  return { default: MockAnthropic };
});

const { AnthropicClient } = await import("./AnthropicClient");

const send = (options?: SendOptions<any>) =>
  new AnthropicClient().sendMessage([{ role: "user", content: "hi" }], options);

const textMessage = (text: string, usage?: Record<string, unknown>) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  ...(usage ? { usage } : {}),
});

const toolUseMessage = (
  blocks: Array<{ id: string; name: string; input: unknown }>,
  text = "",
  usage?: Record<string, unknown>,
) => ({
  stop_reason: "tool_use",
  content: [
    ...(text ? [{ type: "text", text }] : []),
    ...blocks.map((b) => ({
      type: "tool_use",
      id: b.id,
      name: b.name,
      input: b.input,
    })),
  ],
  ...(usage ? { usage } : {}),
});

const echoTool = (overrides: Partial<ToolSpec> = {}): ToolSpec => ({
  name: "echo",
  description: "echoes its argument",
  schema: z.object({ value: z.string() }),
  run: async (input: any) => `echoed:${input.value}`,
  ...overrides,
});

const stopTool = () =>
  echoTool({
    name: "stop",
    schema: z.object({}),
    run: async (_input, ctx) => {
      if (ctx) ctx.stop = true;
      return "stopping";
    },
  });

const toolResultOf = (streamCall: any) =>
  streamCall.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .find((b: any) => b.type === "tool_result");

const toolResultsOf = (streamCall: any) =>
  streamCall.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((b: any) => b.type === "tool_result");

const toolThenText = (toolName: string, text = "recovered") => [
  toolUseMessage([{ id: "t1", name: toolName, input: { value: "x" } }]),
  textMessage(text),
];

afterEach(() => {
  finalMessages = [];
  streamCalls.length = 0;
  constructorArgs.length = 0;
  vi.unstubAllEnvs();
});

describe("AnthropicClient construction", () => {
  it("hands a provided apiKey to the SDK client", () => {
    new AnthropicClient("sk-explicit");
    expect(constructorArgs).toEqual([[{ apiKey: "sk-explicit" }]]);
  });

  it("constructs the SDK client bare when no key is provided, deferring to its env handling", () => {
    new AnthropicClient();
    expect(constructorArgs).toEqual([[]]);
  });
});

describe("AnthropicClient.sendMessage", () => {
  it("returns the text of a direct (non-tool) response", async () => {
    finalMessages = [textMessage("hello there")];
    expect(await send()).toEqual(["hello there"]);
  });

  it("defaults to the Sonnet model and its max tokens", async () => {
    finalMessages = [textMessage("ok")];
    await send();
    expect(streamCalls[0].model).toBe("claude-sonnet-5");
    expect(streamCalls[0].max_tokens).toBe(128000);
  });

  it("honors an explicit model option", async () => {
    finalMessages = [textMessage("ok")];
    await send({ model: "claude-haiku-4-5" });
    expect(streamCalls[0].model).toBe("claude-haiku-4-5");
    expect(streamCalls[0].max_tokens).toBe(64000);
  });

  it("passes the system prompt through", async () => {
    finalMessages = [textMessage("ok")];
    await send({ system: "be terse" });
    expect(streamCalls[0].system).toBe("be terse");
  });

  it("passes a system prompt given as cache_control-bearing text blocks through to the wire unchanged", async () => {
    finalMessages = [textMessage("ok")];
    const system = [
      {
        type: "text" as const,
        text: "stable preamble",
        cache_control: { type: "ephemeral" as const },
      },
      { type: "text" as const, text: "live suffix" },
    ];
    await send({ system });
    expect(streamCalls[0].system).toEqual(system);
  });

  it("passes a system block carrying a one-hour cache ttl through to the wire unchanged", async () => {
    finalMessages = [textMessage("ok")];
    const system = [
      {
        type: "text" as const,
        text: "stable preamble",
        cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
      },
    ];
    await send({ system });
    expect(streamCalls[0].system).toEqual(system);
  });

  it("passes a message block carrying a one-hour cache ttl through to the wire unchanged", async () => {
    finalMessages = [textMessage("ok")];
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "big cacheable context",
            cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
          },
        ],
      },
    ];
    await new AnthropicClient().sendMessage(messages, {});
    expect(streamCalls[0].messages).toEqual(messages);
  });

  it("passes message content blocks carrying cache_control through to the wire unchanged", async () => {
    finalMessages = [textMessage("ok")];
    const content = [
      {
        type: "text" as const,
        text: "big cacheable context",
        cache_control: { type: "ephemeral" as const },
      },
    ];
    await new AnthropicClient().sendMessage([{ role: "user", content }], {});
    expect(streamCalls[0].messages[0].content).toEqual(content);
  });

  it("omits output_config when no effort is set", async () => {
    finalMessages = [textMessage("ok")];
    await send();
    expect(streamCalls[0].output_config).toBeUndefined();
  });

  it("passes effort through as output_config.effort on a model that supports it", async () => {
    finalMessages = [textMessage("ok")];
    await send({ effort: "high" });
    expect(streamCalls[0].output_config).toEqual({ effort: "high" });
  });

  it("omits effort for a model that does not support it", async () => {
    finalMessages = [textMessage("ok")];
    await send({ model: "claude-haiku-4-5", effort: "high" });
    expect(streamCalls[0].output_config).toBeUndefined();
  });

  it("only includes tools in the request when some are provided", async () => {
    finalMessages = [textMessage("ok")];
    await send();
    expect(streamCalls[0].tools).toBeUndefined();

    finalMessages = [textMessage("ok")];
    await send({ tools: [echoTool()] });
    expect(streamCalls[1].tools).toHaveLength(1);
    expect(streamCalls[1].tools[0]).toMatchObject({
      name: "echo",
      description: "echoes its argument",
    });
    expect(streamCalls[1].tools[0].input_schema).toBeDefined();
  });

  it("runs a requested tool and feeds the result back on the next turn", async () => {
    finalMessages = [
      toolUseMessage([{ id: "t1", name: "echo", input: { value: "world" } }]),
      textMessage("done"),
    ];
    expect(await send({ tools: [echoTool()] })).toEqual(["done"]);

    expect(toolResultOf(streamCalls[1])).toMatchObject({
      tool_use_id: "t1",
      content: "echoed:world",
    });
  });

  it("hands the app context to tools as ctx.app", async () => {
    finalMessages = toolThenText("peek");
    const seen: unknown[] = [];
    const peek = echoTool({
      name: "peek",
      run: async (_input, ctx) => {
        seen.push(ctx?.app);
        return "peeked";
      },
    });
    await send({ tools: [peek], context: { tag: "game-state" } });
    expect(seen).toEqual([{ tag: "game-state" }]);
  });

  it("runs a turn's tool calls one at a time, in the order the model asked for them", async () => {
    finalMessages = [
      toolUseMessage([
        { id: "t1", name: "trace", input: { value: "first" } },
        { id: "t2", name: "trace", input: { value: "second" } },
        { id: "t3", name: "trace", input: { value: "third" } },
      ]),
      textMessage("done"),
    ];
    const events: string[] = [];
    const trace = echoTool({
      name: "trace",
      run: async (input: any) => {
        events.push(`start:${input.value}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`end:${input.value}`);
        return `ran:${input.value}`;
      },
    });

    await send({ tools: [trace] });

    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
      "start:third",
      "end:third",
    ]);
    expect(toolResultsOf(streamCalls[1])).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "ran:first" },
      { type: "tool_result", tool_use_id: "t2", content: "ran:second" },
      { type: "tool_result", tool_use_id: "t3", content: "ran:third" },
    ]);
  });

  it("emits text and runs tools in the order the model laid them out in the message", async () => {
    finalMessages = [
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "before" },
          { type: "tool_use", id: "t1", name: "trace", input: { value: "x" } },
          { type: "text", text: "after" },
        ],
      },
      textMessage("done"),
    ];
    const events: string[] = [];
    const trace = echoTool({
      name: "trace",
      run: async () => {
        events.push("tool");
        return "ran";
      },
    });

    const segments = await send({
      tools: [trace],
      onText: (text) => events.push(`text:${text}`),
    });

    expect(events).toEqual(["text:before", "tool", "text:after", "text:done"]);
    expect(segments).toEqual(["before", "after", "done"]);
  });

  it("does not mutate the caller's messages array while running the tool loop", async () => {
    finalMessages = [
      toolUseMessage([{ id: "t1", name: "echo", input: { value: "world" } }]),
      textMessage("done"),
    ];
    const messages = [{ role: "user" as const, content: "hi" }];
    await new AnthropicClient().sendMessage(messages, { tools: [echoTool()] });
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("rejects tool input that fails the tool's schema as an error result, without running the tool", async () => {
    finalMessages = [
      toolUseMessage([{ id: "t1", name: "echo", input: { value: 42 } }]),
      textMessage("recovered"),
    ];
    const run = vi.fn(async () => "ran");
    expect(await send({ tools: [echoTool({ run })] })).toEqual(["recovered"]);
    expect(run).not.toHaveBeenCalled();
    expect(toolResultOf(streamCalls[1])).toMatchObject({
      tool_use_id: "t1",
      is_error: true,
    });
  });

  it("reports an unknown tool as an error result", async () => {
    finalMessages = toolThenText("missing");
    expect(await send({ tools: [echoTool()] })).toEqual(["recovered"]);
    expect(toolResultOf(streamCalls[1])).toMatchObject({
      is_error: true,
      content: "Unknown tool: missing",
    });
  });

  it("captures a throwing tool as an error result", async () => {
    finalMessages = toolThenText("echo");
    const boom = echoTool({
      run: async () => {
        throw new Error("tool exploded");
      },
    });
    await send({ tools: [boom] });
    expect(toolResultOf(streamCalls[1])).toMatchObject({
      is_error: true,
      content: "tool exploded",
    });
  });

  it("stringifies a non-Error thrown by a tool", async () => {
    finalMessages = toolThenText("echo");
    const boom = echoTool({
      run: async () => {
        throw "just a string";
      },
    });
    await send({ tools: [boom] });
    expect(toolResultOf(streamCalls[1])).toMatchObject({
      is_error: true,
      content: "just a string",
    });
  });

  it("stops early with accumulated text when a tool sets ctx.stop", async () => {
    finalMessages = [
      toolUseMessage([{ id: "t1", name: "stop", input: {} }], "farewell"),
    ];
    expect(await send({ tools: [stopTool()] })).toEqual(["farewell"]);
  });

  it("yields no segments when ctx.stop fires with no text and no stopText is configured", async () => {
    finalMessages = [toolUseMessage([{ id: "t1", name: "stop", input: {} }])];
    expect(await send({ tools: [stopTool()] })).toEqual([]);
  });

  it("falls back to the configured stopText when ctx.stop fires with no text", async () => {
    finalMessages = [toolUseMessage([{ id: "t1", name: "stop", input: {} }])];
    expect(
      await send({ tools: [stopTool()], stopText: "[The Weaver disengages.]" }),
    ).toEqual(["[The Weaver disengages.]"]);
  });

  it("does not emit stopText when the stopped turn already produced text", async () => {
    finalMessages = [
      toolUseMessage([{ id: "t1", name: "stop", input: {} }], "farewell"),
    ];
    expect(await send({ tools: [stopTool()], stopText: "[gone]" })).toEqual([
      "farewell",
    ]);
  });

  it("yields no segments when the final response carries no text", async () => {
    finalMessages = [{ stop_reason: "end_turn", content: [{ type: "image" }] }];
    expect(await send()).toEqual([]);
  });

  it("reports context usage as the sum of fresh, cache-write, and cache-read tokens against the model's context window", async () => {
    finalMessages = [
      textMessage("ok", {
        input_tokens: 499_500,
        output_tokens: 100,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 200,
      }),
    ];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 499_500,
      outputTokens: 100,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 200,
      contextWindow: 1_000_000,
      percentUsed: 50,
    });
  });

  it("normalizes null cache usage fields to zero", async () => {
    finalMessages = [
      textMessage("ok", {
        input_tokens: 1000,
        output_tokens: 10,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
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

  it("looks up the context window for the model actually used", async () => {
    finalMessages = [
      textMessage("ok", {
        input_tokens: 100_000,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const onUsage = vi.fn();
    await send({ model: "claude-haiku-4-5", onUsage });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindow: 200_000, percentUsed: 50 }),
    );
  });

  it("does not call onUsage when the response carries no usage data", async () => {
    finalMessages = [textMessage("ok")];
    const onUsage = vi.fn();
    await send({ onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("throws after exceeding the tool-use turn limit", async () => {
    finalMessages = Array.from({ length: 8 }, () =>
      toolUseMessage([{ id: "t1", name: "echo", input: { value: "x" } }]),
    );
    await expect(send({ tools: [echoTool()] })).rejects.toThrow(
      /exceeded 8 tool-use turns/,
    );
  });
});

describe("AnthropicClient.destroy", () => {
  it("resolves without throwing", async () => {
    await expect(new AnthropicClient().destroy()).resolves.toBeUndefined();
  });
});
