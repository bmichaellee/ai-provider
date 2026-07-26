import { afterEach, describe, expect, it, vi } from "vitest";

import { describeConformance } from "../../conformance/suite";
import type { ConformanceBackend } from "../../conformance/types";
import { createAnthropicBackend } from "./conformance/anthropicBackend";
import { createLocalBackend } from "./conformance/localBackend";
import { DEFAULT_MODEL } from "./types";

/**
 * One mocked file driving both backends through the same assertions, so a
 * guarantee cannot hold on one and silently rot on the other.
 *
 * The two factories mock disjoint specifiers and the two clients import
 * disjoint modules, so they cannot interfere. Each factory reaches its
 * adapter by dynamic import: vi.mock is hoisted above every declaration, and
 * a factory closing over adapter state any other way would read it before
 * initialization.
 *
 * Named *.conformance.test.ts, not *.behavior.test.ts — the latter routes to
 * the live `llm` project, which hits a real backend.
 */

vi.mock("@anthropic-ai/sdk", async () => {
  const { anthropicSdkMock } = await import("./conformance/anthropicBackend");
  return anthropicSdkMock();
});

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const { agentSdkMock } = await import("./conformance/localBackend");
  return agentSdkMock();
});

const { AnthropicClient } = await import("./AnthropicClient/AnthropicClient");
const { LocalClient } = await import("./LocalClient/LocalClient");

const backends: ConformanceBackend[] = [
  createAnthropicBackend(() => new AnthropicClient("sk-conformance")),
  createLocalBackend(() => new LocalClient(), DEFAULT_MODEL),
];

// Every backend is reset, not just the one whose block ran, so a leaked queue
// can never travel from one describe.each branch into the next.
afterEach(() => {
  for (const backend of backends) backend.reset();
});

describe.each(backends)("$kind backend", (backend) => {
  describeConformance(backend);
});

describe("cross-backend agreement", () => {
  const [anthropic, local] = backends;
  const script = {
    calls: [
      { text: "one", usage: { inputTokens: 100, outputTokens: 10 } },
      { text: "two", usage: { inputTokens: 200, outputTokens: 20 } },
    ],
  };

  /** Fields every backend must report, regardless of which one answered. */
  const CORE_CONTEXT_KEYS = [
    "inputTokens",
    "outputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "contextWindow",
    "percentUsed",
    "iteration",
    "providerKind",
  ];
  const CORE_TURN_KEYS = [
    "inputTokens",
    "outputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "iterationCount",
    "contextWindow",
    "providerKind",
  ];
  /** Backend-specific additions that are allowed on top of the core set. */
  const OPTIONAL_KEYS = ["sessionOverheadTokens", "costUSD"];

  const runBoth = async () => {
    const captured = [];
    for (const backend of [anthropic, local]) {
      const usages: any[] = [];
      const turns: any[] = [];
      const segments = await backend.run(script, {
        onUsage: (event) => usages.push(event),
        onTurnUsage: (event) => turns.push(event),
      });
      backend.reset();
      captured.push({ kind: backend.kind, segments, usages, turns });
    }
    return captured;
  };

  it("reports the same context usage fields from either backend", async () => {
    const [first, second] = await runBoth();
    for (const { usages } of [first, second]) {
      for (const event of usages) {
        expect(Object.keys(event)).toEqual(
          expect.arrayContaining(CORE_CONTEXT_KEYS),
        );
        const extras = Object.keys(event).filter(
          (key) => !CORE_CONTEXT_KEYS.includes(key),
        );
        expect(extras.every((key) => OPTIONAL_KEYS.includes(key))).toBe(true);
      }
    }
  });

  it("reports the same turn usage fields from either backend", async () => {
    const [first, second] = await runBoth();
    for (const { turns } of [first, second]) {
      expect(Object.keys(turns[0])).toEqual(
        expect.arrayContaining(CORE_TURN_KEYS),
      );
      const extras = Object.keys(turns[0]).filter(
        (key) => !CORE_TURN_KEYS.includes(key),
      );
      expect(extras.every((key) => OPTIONAL_KEYS.includes(key))).toBe(true);
    }
  });

  it("returns the same segments from either backend for one script", async () => {
    const [first, second] = await runBoth();
    expect(first.segments).toEqual(second.segments);
  });

  it("reports the same token numbers from either backend for one script", async () => {
    const [first, second] = await runBoth();
    const comparable = (event: any) => ({
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
      contextWindow: event.contextWindow,
      percentUsed: event.percentUsed,
      iteration: event.iteration,
    });
    expect(first.usages.map(comparable)).toEqual(second.usages.map(comparable));

    const comparableTurn = (event: any) => ({
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
      contextWindow: event.contextWindow,
    });
    expect(comparableTurn(first.turns[0])).toEqual(
      comparableTurn(second.turns[0]),
    );
  });
});
