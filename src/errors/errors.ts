import type { ProviderKind } from "../types";

/**
 * Provider policy category for a refusal. Deliberately an open union: the
 * catalogued categories grow over time, and pinning this to a closed list
 * would make every upstream addition a breaking change here. The literals
 * are for autocomplete.
 */
export type RefusalCategory =
  | "cyber"
  | "bio"
  | "frontier_llm"
  | "reasoning_extraction"
  | "general_harms"
  | (string & {});

/**
 * The model declined the request. The backend returned a successful response
 * whose stop reason was a refusal — without this error that arrives as an
 * empty, successful turn, indistinguishable from a model that had nothing to
 * say.
 */
export class RefusalError extends Error {
  /** Backend that produced the refusal. */
  readonly providerKind: ProviderKind;
  /** Model asked for when the refusal happened. */
  readonly model: string;
  /** Policy category when the provider reported one, else null. */
  readonly category: RefusalCategory | null;
  /**
   * Provider prose when available, else null. Not a stable contract — log it,
   * don't branch on it.
   */
  readonly explanation: string | null;

  constructor(init: {
    providerKind: ProviderKind;
    model: string;
    category?: RefusalCategory | null;
    explanation?: string | null;
  }) {
    super(
      `${init.model} declined the request (category: ${
        init.category ?? "unspecified"
      })${init.explanation ? `: ${init.explanation}` : ""}`,
    );
    this.name = "RefusalError";
    this.providerKind = init.providerKind;
    this.model = init.model;
    this.category = init.category ?? null;
    this.explanation = init.explanation ?? null;
  }
}

/**
 * Prefer this to `instanceof` at package boundaries: a consumer that resolves
 * two copies of this package (transitive dependency, hoisting miss) gets two
 * distinct classes, and `instanceof` silently returns false for one of them.
 */
export const isRefusalError = (error: unknown): error is RefusalError =>
  error instanceof Error && error.name === "RefusalError";
