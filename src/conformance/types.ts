import type { AIProvider, ProviderKind, SendOptions } from "../types";

/** Token counts for one scripted model API call. */
export type ScriptedUsage = {
  inputTokens: number;
  outputTokens: number;
  /** null exercises the SDKs' nullable cache fields. */
  cacheCreation?: number | null;
  cacheRead?: number | null;
};

export type ScriptedCall = {
  /**
   * Assistant text for this call. Never blank in a shared script: the local
   * backend drops whitespace-only text while the metered one drops only the
   * empty string, and a neutral script must not sit on that divergence.
   */
  text?: string;
  /**
   * Reasoning the model produced before `text`. Scripted unconditionally —
   * the adapters do not model `thinking.display`, so a backend that requested
   * omitted thinking still sees blocks here. That is deliberate: it lets the
   * suite assert thinking stays out of the transcript without relying on the
   * request-side switch to do the work.
   */
  thinking?: string;
  usage?: ScriptedUsage;
};

/**
 * A backend-neutral description of one turn. Each adapter translates it into
 * whichever wire shape its SDK expects, so one script can be run against both
 * backends and the results compared.
 */
export type Script = {
  /** One entry per model API call the turn should make, in order. */
  calls: ScriptedCall[];
  /** 1-based index of the call after which an app tool sets ctx.stop. */
  stopAfterCall?: number;
  /** End the turn with a policy refusal instead of a completion. */
  refusal?: { category: string | null; explanation: string | null };
};

export type ConformanceBackend = {
  kind: ProviderKind;
  newClient: () => AIProvider;
  /** Script a turn and run it, optionally against a caller-supplied client. */
  run: (
    script: Script,
    options?: SendOptions<any>,
    client?: AIProvider,
  ) => Promise<string[]>;
  reset: () => void;
};
