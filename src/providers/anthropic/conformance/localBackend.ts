import { z } from "zod";

import type {
  ConformanceBackend,
  Script,
  ScriptedUsage,
} from "../../../conformance/types";
import type { AIProvider, SendOptions, ToolSpec } from "../../../types";

/**
 * Mock state and script translation for the local backend. Imports neither
 * the Agent SDK nor LocalClient — see the note in anthropicBackend.ts.
 */

const queryMessages: any[] = [];
export const queryCalls: any[] = [];
const sdkTools: { name: string; handler: (args: any) => Promise<any> }[] = [];

export const agentSdkMock = () => ({
  query: (opts: any) => {
    queryCalls.push(opts);
    const messages = [...queryMessages];
    async function* gen() {
      for (const message of messages) {
        if (message.type === "__runTool") {
          // Looked up by name, not index: run() may be called more than once
          // per test, and index lookup silently drifts on the second send.
          const tool = [...sdkTools]
            .reverse()
            .find((candidate) => candidate.name === message.name);
          await tool?.handler(message.args ?? {});
          continue;
        }
        yield message;
      }
    }
    const iterator = gen();
    return {
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      return: async () => ({ value: undefined, done: true }),
    };
  },
  createSdkMcpServer: (config: any) => ({ __server: config }),
  tool: (name: string, description: string, shape: unknown, handler: any) => {
    sdkTools.push({ name, handler });
    return { name, description, shape, handler };
  },
});

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

/**
 * The metered backend derives turn totals by summing per-call usage; this one
 * reads them off the terminal result. Defaulting the result to that same sum
 * makes one script produce comparable TurnUsage on both backends.
 */
const sumOf = (calls: Script["calls"]): ScriptedUsage | undefined => {
  const scripted = calls.filter((call) => call.usage);
  if (!scripted.length) return undefined;
  return scripted.reduce<ScriptedUsage>(
    (total, call) => ({
      inputTokens: total.inputTokens + (call.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (call.usage?.outputTokens ?? 0),
      cacheCreation:
        (total.cacheCreation ?? 0) + (call.usage?.cacheCreation ?? 0),
      cacheRead: (total.cacheRead ?? 0) + (call.usage?.cacheRead ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0 },
  );
};

const toQueryMessages = (script: Script, model: string) => {
  const out: any[] = [];
  // Calls scripted after the stop point are never reached: setting ctx.stop
  // ends the turn, on this backend as on the metered one.
  const reached =
    script.stopAfterCall === undefined
      ? script.calls
      : script.calls.slice(0, script.stopAfterCall);
  reached.forEach((call, i) => {
    out.push({
      type: "assistant",
      message: {
        id: `m${i}`,
        ...(call.usage ? { usage: wireUsage(call.usage) } : {}),
        content: [
          ...(call.thinking
            ? [{ type: "thinking", thinking: call.thinking }]
            : []),
          ...(call.text ? [{ type: "text", text: call.text }] : []),
        ],
      },
    });
    if (script.stopAfterCall === i + 1)
      out.push({ type: "__runTool", name: stopper.name, args: {} });
  });

  if (script.refusal) {
    out.push({
      type: "system",
      subtype: "model_refusal_no_fallback",
      original_model: model,
      api_refusal_category: script.refusal.category,
      api_refusal_explanation: script.refusal.explanation,
      content: "I can't help with that.",
    });
  }

  const totals = sumOf(reached);
  out.push({
    type: "result",
    subtype: "success",
    result: reached.at(-1)?.text ?? "",
    ...(totals ? { usage: wireUsage(totals) } : {}),
    num_turns: reached.length,
    // Agrees with the catalog by default. The divergent case is deliberately
    // a local-only test, since the metered backend cannot reproduce it.
    modelUsage: {},
  });
  return out;
};

export const createLocalBackend = (
  newClient: () => AIProvider,
  model: string,
): ConformanceBackend => ({
  kind: "local",
  newClient,
  reset: () => {
    queryMessages.length = 0;
    queryCalls.length = 0;
    sdkTools.length = 0;
  },
  run: (script, options: SendOptions<any> = {}, client = newClient()) => {
    queryMessages.push(...toQueryMessages(script, options.model ?? model));
    return client.sendMessage([{ role: "user", content: "hi" }], {
      ...options,
      ...(script.stopAfterCall !== undefined
        ? { tools: [stopper, ...(options.tools ?? [])] }
        : {}),
    });
  },
});
