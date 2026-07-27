import { z } from "zod";

import type {
  ConformanceBackend,
  Script,
  ScriptedUsage,
} from "../../../conformance/types";
import type { AIProvider, SendOptions, ToolSpec } from "../../../types";

/**
 * Mock state and script translation for the metered backend.
 *
 * Imports neither the Anthropic SDK nor AnthropicClient: the vi.mock factory
 * in the conformance entry file reaches this module by dynamic import, and a
 * static import either way would create a cycle.
 */

const finalMessages: any[] = [];
export const streamCalls: any[] = [];

/** The module shape vi.mock("@anthropic-ai/sdk") returns. */
export const anthropicSdkMock = () => {
  class MockAnthropic {
    messages = {
      stream: (params: any) => {
        streamCalls.push(params);
        const message = finalMessages.shift();
        return { finalMessage: async () => message };
      },
    };
    constructor(..._args: any[]) {}
  }
  return { default: MockAnthropic };
};

/**
 * This backend only makes another API call when the previous one asked for a
 * tool, so a multi-call script is expressed as repeated calls to a no-op
 * tool. The local adapter needs no such device — absorbing that asymmetry is
 * exactly the adapter's job.
 */
const advance: ToolSpec = {
  name: "conformance_advance",
  description: "internal: drives the tool loop to the next scripted call",
  schema: z.object({}),
  run: async () => "ok",
};

const stopper: ToolSpec = {
  name: "conformance_stop",
  description: "internal: ends the turn via ctx.stop",
  schema: z.object({}),
  run: async (_input: any, ctx?: any) => {
    if (ctx) ctx.stop = true;
    return "stopped";
  },
};

const wireUsage = (usage: ScriptedUsage) => ({
  input_tokens: usage.inputTokens,
  output_tokens: usage.outputTokens,
  cache_creation_input_tokens: usage.cacheCreation ?? 0,
  cache_read_input_tokens: usage.cacheRead ?? 0,
});

const toFinalMessages = (script: Script) => {
  const last = script.calls.length - 1;
  return script.calls.map((call, i) => {
    const stopsHere = script.stopAfterCall === i + 1;
    const refuses = i === last && !!script.refusal && !stopsHere;
    const continues = i < last || stopsHere;
    return {
      stop_reason: refuses ? "refusal" : continues ? "tool_use" : "end_turn",
      ...(refuses ? { stop_details: { type: "refusal", ...script.refusal } } : {}),
      content: refuses
        ? []
        : [
            ...(call.thinking
              ? [{ type: "thinking", thinking: call.thinking }]
              : []),
            ...(call.text ? [{ type: "text", text: call.text }] : []),
            ...(continues
              ? [
                  {
                    type: "tool_use",
                    id: `t${i}`,
                    name: stopsHere ? stopper.name : advance.name,
                    input: {},
                  },
                ]
              : []),
          ],
      ...(call.usage ? { usage: wireUsage(call.usage) } : {}),
    };
  });
};

export const createAnthropicBackend = (
  newClient: () => AIProvider,
): ConformanceBackend => ({
  kind: "anthropic",
  newClient,
  reset: () => {
    finalMessages.length = 0;
    streamCalls.length = 0;
  },
  run: (script, options: SendOptions<any> = {}, client = newClient()) => {
    finalMessages.push(...toFinalMessages(script));
    const needsLoop =
      script.calls.length > 1 || script.stopAfterCall !== undefined;
    return client.sendMessage([{ role: "user", content: "hi" }], {
      ...options,
      ...(needsLoop
        ? { tools: [advance, stopper, ...(options.tools ?? [])] }
        : {}),
    });
  },
});
