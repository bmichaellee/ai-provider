import { AnthropicClient, LocalClient } from "../providers";
import type { AIProvider } from "../types";

export type ProviderBackend = "anthropic" | "local";

export type ProviderConfig = {
  backend?: ProviderBackend;
  apiKey?: string;
};

export const createProvider = (config: ProviderConfig = {}): AIProvider => {
  const backend =
    config.backend ??
    (config.apiKey || process.env.ANTHROPIC_API_KEY ? "anthropic" : "local");
  return backend === "anthropic"
    ? new AnthropicClient(config.apiKey)
    : new LocalClient();
};
