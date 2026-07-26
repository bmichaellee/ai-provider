import { afterEach, describe, expect, it, vi } from "vitest";

const anthropicSend = vi.fn(async () => ["anthropic-reply"]);
const anthropicKeys: Array<string | undefined> = [];
const localSend = vi.fn(async () => ["local-reply"]);

vi.mock("../providers", () => ({
  AnthropicClient: class {
    providerKind = "anthropic";
    sendMessage = anthropicSend;
    destroy = async () => {};
    constructor(apiKey?: string) {
      anthropicKeys.push(apiKey);
    }
  },
  LocalClient: class {
    providerKind = "local";
    sendMessage = localSend;
    destroy = async () => {};
  },
}));

const { createProvider, resolveProviderKind } = await import(
  "./createProvider"
);
const { AnthropicClient, LocalClient } = await import("../providers");

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  anthropicKeys.length = 0;
});

describe("createProvider", () => {
  it("selects the Anthropic backend when ANTHROPIC_API_KEY is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    const provider = createProvider();
    expect(provider).toBeInstanceOf(AnthropicClient);
    expect(provider.providerKind).toBe("anthropic");
    expect(
      await provider.sendMessage([{ role: "user", content: "hi" }]),
    ).toEqual(["anthropic-reply"]);
    expect(localSend).not.toHaveBeenCalled();
  });

  it("selects the local backend when ANTHROPIC_API_KEY is unset", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const provider = createProvider();
    expect(provider).toBeInstanceOf(LocalClient);
    expect(provider.providerKind).toBe("local");
    expect(
      await provider.sendMessage([{ role: "user", content: "hi" }]),
    ).toEqual(["local-reply"]);
  });

  it("lets an explicit local backend override an ambient key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    expect(createProvider({ backend: "local" })).toBeInstanceOf(LocalClient);
  });

  it("lets an explicit anthropic backend be chosen without an ambient key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createProvider({ backend: "anthropic" })).toBeInstanceOf(
      AnthropicClient,
    );
  });

  it("treats a config apiKey as choosing the Anthropic backend and hands the key over", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createProvider({ apiKey: "sk-config" })).toBeInstanceOf(
      AnthropicClient,
    );
    expect(anthropicKeys).toEqual(["sk-config"]);
  });

  it("constructs the Anthropic backend keyless when only the env provides one", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    createProvider();
    expect(anthropicKeys).toEqual([undefined]);
  });
});

describe("resolveProviderKind", () => {
  it("reports the anthropic backend when ANTHROPIC_API_KEY is set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    expect(resolveProviderKind()).toBe("anthropic");
  });

  it("reports the local backend when ANTHROPIC_API_KEY is unset", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(resolveProviderKind()).toBe("local");
  });

  it("honours an explicit backend over the ambient environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    expect(resolveProviderKind({ backend: "local" })).toBe("local");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(resolveProviderKind({ backend: "anthropic" })).toBe("anthropic");
  });

  it("treats a config apiKey as selecting the anthropic backend", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(resolveProviderKind({ apiKey: "sk-config" })).toBe("anthropic");
  });

  it("answers without constructing a client", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    resolveProviderKind();
    resolveProviderKind({ backend: "local" });
    expect(anthropicKeys).toEqual([]);
    expect(anthropicSend).not.toHaveBeenCalled();
    expect(localSend).not.toHaveBeenCalled();
  });

  it("agrees with the backend createProvider actually builds", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    expect(createProvider().providerKind).toBe(resolveProviderKind());
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createProvider().providerKind).toBe(resolveProviderKind());
  });
});
