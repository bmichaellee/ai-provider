import { expect, it, vi } from "vitest";

import type { ConformanceBackend } from "./types";
import { contextUsageSchema, turnUsageSchema } from "../schemas";
import { isRefusalError } from "../errors";
import type { ContextUsage, TurnUsage } from "../types";

/**
 * The guarantees every backend must honour. Kept as a plain function rather
 * than inlined into the entry file so the suite can be split per backend
 * later without touching a single assertion.
 */
export const describeConformance = (backend: ConformanceBackend) => {
  const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 1 });

  const collect = () => {
    const usages: ContextUsage[] = [];
    const turns: TurnUsage[] = [];
    return {
      usages,
      turns,
      options: {
        // Strict-parsed on the way in: this catches drift the compile-time
        // Equal<> assertions can't — a client that stops setting a field, or
        // starts setting one the schema doesn't know about.
        onUsage: (event: ContextUsage) => {
          contextUsageSchema.strict().parse(event);
          usages.push(event);
        },
        onTurnUsage: (event: TurnUsage) => {
          turnUsageSchema.strict().parse(event);
          turns.push(event);
        },
      },
    };
  };

  it("reports its own backend kind", () => {
    expect(backend.newClient().providerKind).toBe(backend.kind);
  });

  it("stamps every context usage event with the backend that produced it", async () => {
    const { usages, options } = collect();
    await backend.run(
      { calls: [{ text: "a", usage: usage(10) }, { text: "b", usage: usage(20) }] },
      options,
    );
    expect(usages.length).toBeGreaterThan(0);
    expect(usages.map((event) => event.providerKind)).toEqual(
      usages.map(() => backend.kind),
    );
  });

  it("stamps the turn usage event with the backend that produced it", async () => {
    const { turns, options } = collect();
    await backend.run({ calls: [{ text: "a", usage: usage(10) }] }, options);
    expect(turns).toHaveLength(1);
    expect(turns[0].providerKind).toBe(backend.kind);
  });

  it("numbers context usage events 1-based and in order", async () => {
    const { usages, options } = collect();
    await backend.run(
      {
        calls: [
          { text: "a", usage: usage(10) },
          { text: "b", usage: usage(20) },
          { text: "c", usage: usage(30) },
        ],
      },
      options,
    );
    expect(usages.map((event) => event.iteration)).toEqual([1, 2, 3]);
  });

  it("restarts iteration numbering for a second turn on the same client", async () => {
    const client = backend.newClient();
    const { usages, options } = collect();
    const script = {
      calls: [{ text: "a", usage: usage(10) }, { text: "b", usage: usage(20) }],
    };
    await backend.run(script, options, client);
    await backend.run(script, options, client);
    expect(usages.map((event) => event.iteration)).toEqual([1, 2, 1, 2]);
  });

  it("reports turn usage exactly once for a multi-call turn", async () => {
    const { turns, options } = collect();
    await backend.run(
      {
        calls: [
          { text: "a", usage: usage(10) },
          { text: "b", usage: usage(20) },
          { text: "c", usage: usage(30) },
        ],
      },
      options,
    );
    expect(turns).toHaveLength(1);
  });

  it("reports turn usage exactly once when a tool ends the turn early", async () => {
    const { turns, options } = collect();
    await backend.run(
      {
        calls: [{ text: "a", usage: usage(10) }, { text: "b", usage: usage(20) }],
        stopAfterCall: 1,
      },
      options,
    );
    expect(turns).toHaveLength(1);
  });

  it("reports turn usage after the last context usage event", async () => {
    const order: string[] = [];
    await backend.run(
      { calls: [{ text: "a", usage: usage(10) }, { text: "b", usage: usage(20) }] },
      {
        onUsage: () => order.push("call"),
        onTurnUsage: () => order.push("turn"),
      },
    );
    expect(order.at(-1)).toBe("turn");
    expect(order.filter((entry) => entry === "turn")).toHaveLength(1);
  });

  it("reports no turn usage when no call carried usage data", async () => {
    const { turns, options } = collect();
    await backend.run({ calls: [{ text: "a" }] }, options);
    expect(turns).toHaveLength(0);
  });

  it("measures fullness as fresh plus cache-write plus cache-read tokens", async () => {
    const { usages, options } = collect();
    await backend.run(
      {
        calls: [
          {
            text: "a",
            // Chosen so each term moves the answer: fresh alone reads 40,
            // fresh + cache-write 45, all three 50. An implementation that
            // dropped either cache term would fail rather than round back to
            // the same number.
            usage: {
              inputTokens: 400_000,
              outputTokens: 100,
              cacheCreation: 50_000,
              cacheRead: 50_000,
            },
          },
        ],
      },
      { ...options, model: "claude-sonnet-5" as any },
    );
    expect(usages[0].percentUsed).toBe(50);
    expect(usages[0].contextWindow).toBe(1_000_000);
  });

  it("keeps fullness a real number for a model absent from the catalog", async () => {
    const { usages, turns, options } = collect();
    await backend.run(
      { calls: [{ text: "a", usage: usage(1000) }] },
      { ...options, model: "claude-not-a-real-model" as any },
    );
    for (const event of usages) {
      expect(Number.isFinite(event.percentUsed)).toBe(true);
      expect(event.percentUsed).not.toBeNull();
      expect(event.contextWindow).toBeGreaterThan(0);
    }
    expect(turns[0].contextWindow).toBeGreaterThan(0);
  });

  it("normalizes null cache token counts to zero rather than NaN", async () => {
    const { usages, options } = collect();
    await backend.run(
      {
        calls: [
          {
            text: "a",
            usage: {
              inputTokens: 100,
              outputTokens: 1,
              cacheCreation: null,
              cacheRead: null,
            },
          },
        ],
      },
      options,
    );
    expect(usages[0].cacheCreationInputTokens).toBe(0);
    expect(usages[0].cacheReadInputTokens).toBe(0);
    expect(Number.isFinite(usages[0].percentUsed)).toBe(true);
  });

  it("sizes fullness by the requested model's window", async () => {
    const { usages, options } = collect();
    await backend.run(
      { calls: [{ text: "a", usage: usage(100_000) }] },
      { ...options, model: "claude-haiku-4-5" as any },
    );
    expect(usages[0].contextWindow).toBe(200_000);
    expect(usages[0].percentUsed).toBe(50);
  });

  it("reports one context window across every event of a turn", async () => {
    const { usages, turns, options } = collect();
    await backend.run(
      { calls: [{ text: "a", usage: usage(10) }, { text: "b", usage: usage(20) }] },
      { ...options, model: "claude-haiku-4-5" as any },
    );
    expect(new Set(usages.map((event) => event.contextWindow)).size).toBe(1);
    expect(turns[0].contextWindow).toBe(usages.at(-1)!.contextWindow);
  });

  it("raises a refusal rather than resolving as an empty successful turn", async () => {
    const refusal = { category: "cyber", explanation: "declined" };
    await expect(
      backend.run({ calls: [{ usage: usage(10) }], refusal }),
    ).rejects.toSatisfy(isRefusalError);
  });

  it("carries the provider's refusal category, explanation and backend", async () => {
    const refusal = { category: "cyber", explanation: "declined" };
    await expect(
      backend.run({ calls: [{ usage: usage(10) }], refusal }),
    ).rejects.toMatchObject({
      category: "cyber",
      explanation: "declined",
      providerKind: backend.kind,
    });
  });

  it("reports the turn's spend before raising a refusal", async () => {
    const onTurnUsage = vi.fn();
    await expect(
      backend.run(
        {
          calls: [{ usage: usage(10) }],
          refusal: { category: "bio", explanation: null },
        },
        { onTurnUsage },
      ),
    ).rejects.toSatisfy(isRefusalError);
    expect(onTurnUsage).toHaveBeenCalledTimes(1);
  });

  it("emits exactly the segments it returns", async () => {
    const streamed: string[] = [];
    const segments = await backend.run(
      { calls: [{ text: "one", usage: usage(10) }] },
      { onText: (segment) => streamed.push(segment) },
    );
    expect(streamed).toEqual(segments);
  });

  it("returns no segments when a stopping tool produces no text", async () => {
    const segments = await backend.run({
      calls: [{ usage: usage(10) }, { usage: usage(20) }],
      stopAfterCall: 1,
    });
    expect(segments).toEqual([]);
  });

  it("falls back to stopText when a stopping tool produces no text", async () => {
    const segments = await backend.run(
      { calls: [{ usage: usage(10) }, { usage: usage(20) }], stopAfterCall: 1 },
      { stopText: "[The Weaver disengages.]" },
    );
    expect(segments).toEqual(["[The Weaver disengages.]"]);
  });

  // Deliberately not asserted cross-backend: whether text already written in
  // the same API message as the stopping tool call survives the stop is a
  // real divergence. The metered backend emits it; the local one suppresses
  // it, since text buffered against an identified message is discarded once
  // ctx.stop is set. Each unit suite pins its own side.
};
