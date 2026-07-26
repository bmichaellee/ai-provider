import { z } from "zod";

import type { ToolSpec } from "../types";

/**
 * Tool fixtures shared by the unit suites and the conformance suite. Test-only
 * — nothing here is reachable from src/index.ts, so it is never bundled.
 */

export const echoTool = (overrides: Partial<ToolSpec> = {}): ToolSpec => ({
  name: "echo",
  description: "echoes",
  schema: z.object({ value: z.string() }),
  run: async (input: any) => `echoed:${input.value}`,
  ...overrides,
});

/** Sets ctx.stop, ending the turn after the current call. */
export const stopTool = (overrides: Partial<ToolSpec> = {}): ToolSpec => ({
  name: "stop",
  description: "stops the conversation",
  schema: z.object({}),
  run: async (_input: any, ctx?: any) => {
    if (ctx) ctx.stop = true;
    return "stopped";
  },
  ...overrides,
});
