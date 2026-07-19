import { describe, expect, it } from "vitest";

import { createProvider } from "../../createProvider";

describe("Provider Behavior", () => {
  it("should respond with the name of a certain famous mathematician", async () => {
    const provider = createProvider();

    return provider
      .sendMessage([{ role: "user", content: "Hello, what is your namesake?" }])
      .then((segments) => {
        expect(segments.join(" ")).toMatch(/shannon/i);
      })
      .finally(() => provider.destroy());
  }, 30_000);
});
