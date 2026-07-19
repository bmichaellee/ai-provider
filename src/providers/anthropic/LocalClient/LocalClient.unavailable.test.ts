import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw Object.assign(
    new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'"),
    {
      code: "ERR_MODULE_NOT_FOUND",
    },
  );
});

const { LocalClient } = await import("./LocalClient");

describe("LocalClient without the agent SDK installed", () => {
  it("constructs without touching the SDK", () => {
    expect(() => new LocalClient()).not.toThrow();
  });

  it("rejects sendMessage with an instructive error naming the missing optional peer", async () => {
    await expect(
      new LocalClient().sendMessage([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/@anthropic-ai\/claude-agent-sdk/);
  });
});
