import type { ToolContext, ToolSpec } from "../types";

export const executeTool = async <TApp>(
  tool: ToolSpec<any, TApp>,
  input: unknown,
  ctx?: ToolContext<TApp>,
): Promise<string> => {
  const result = await tool.run(input, ctx);
  if (process.env.DEBUG_TOOL_CALLS) {
    console.log("[tool call]", { name: tool.name, input, result });
  }
  return result;
};
