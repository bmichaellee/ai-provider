import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../types";
import { executeTool } from "./executeTool";
import { echoTool } from "../testing/tools";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeTool", () => {
  it("runs the tool and returns its result", async () => {
    const result = await executeTool(echoTool(), { value: "world" });
    expect(result).toBe("echoed:world");
  });

  it("does not log tool calls by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await executeTool(echoTool(), { value: "world" });
    expect(log).not.toHaveBeenCalled();
  });

  it("logs the tool name, input, and result when DEBUG_TOOL_CALLS is set", async () => {
    const previous = process.env.DEBUG_TOOL_CALLS;
    process.env.DEBUG_TOOL_CALLS = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await executeTool(echoTool(), { value: "world" });
      expect(log).toHaveBeenCalledWith("[tool call]", {
        name: "echo",
        input: { value: "world" },
        result: "echoed:world",
      });
    } finally {
      if (previous === undefined) delete process.env.DEBUG_TOOL_CALLS;
      else process.env.DEBUG_TOOL_CALLS = previous;
    }
  });

  it("passes the tool context through to run", async () => {
    const ctx: ToolContext = { stop: false };
    const stopper = echoTool({
      name: "stop",
      run: async (_input, received) => {
        if (received) received.stop = true;
        return "stopping";
      },
    });
    await executeTool(stopper, {}, ctx);
    expect(ctx.stop).toBe(true);
  });

  it("delivers the app context to the tool", async () => {
    const seen: unknown[] = [];
    const ctx: ToolContext<{ tag: string }> = {
      stop: false,
      app: { tag: "hello" },
    };
    const spy = echoTool({
      run: async (_input, received) => {
        seen.push(received?.app);
        return "ok";
      },
    });
    await executeTool(spy, {}, ctx);
    expect(seen).toEqual([{ tag: "hello" }]);
  });

  it("does not swallow a throwing tool", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const boom = echoTool({
      run: async () => {
        throw new Error("kaboom");
      },
    });
    await expect(executeTool(boom, { value: "x" })).rejects.toThrow("kaboom");
  });
});
