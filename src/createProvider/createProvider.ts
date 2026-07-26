import { AnthropicClient, LocalClient } from "../providers";
import type { AIProvider, ProviderKind } from "../types";

export type ProviderBackend = ProviderKind;

export type ProviderConfig = {
  backend?: ProviderBackend;
  apiKey?: string;
};

/**
 * Which backend a given config selects, without constructing one. Reads the
 * environment at call time, so a health check reflects the environment as it
 * is now rather than as it was at module load.
 */
export const resolveProviderKind = (
  config: ProviderConfig = {},
): ProviderKind =>
  config.backend ??
  (config.apiKey || process.env.ANTHROPIC_API_KEY ? "anthropic" : "local");

export const createProvider = (config: ProviderConfig = {}): AIProvider =>
  resolveProviderKind(config) === "anthropic"
    ? new AnthropicClient(config.apiKey)
    : new LocalClient();
