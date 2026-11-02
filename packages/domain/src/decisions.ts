/**
 * One atomic question with a closed answer set. Keep questions free of
 * arithmetic, counting and multi-hop reasoning; split those and combine the
 * answers in code.
 */
export interface DecisionQuestion<Option extends string = string> {
  readonly name: string;
  readonly instructions: string;
  readonly options: readonly Option[];
}

/** A typed answer. Every decision is recorded as an audit event. */
export interface Decision<Option extends string = string> {
  readonly question: string;
  readonly choice: Option;
  readonly probability: number;
  readonly engine: string;
  readonly engineVersion: string;
  /** Which prompt produced it, when the engine uses one (name and content hash). */
  readonly promptVersion: string | null;
}

/** Tokens one model call consumed, and what they cost. */
export interface ModelUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}

export interface DecisionContext {
  readonly signal?: AbortSignal;
  /**
   * Called once per billed model call, including calls whose answer is then
   * rejected, so spend is metered even when a decision fails.
   */
  readonly onUsage?: (usage: ModelUsage) => void;
}

/**
 * The decision layer. Implementations wrap a decision model (such as Jev) or
 * an LLM constrained to the options, so engines can be swapped and compared
 * per question.
 */
export interface DecisionModel {
  readonly engine: string;
  decide<Option extends string>(
    question: DecisionQuestion<Option>,
    state: string,
    context?: DecisionContext,
  ): Promise<Decision<Option>>;
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

/** Below the threshold the caller takes the question's safe fallback. */
export function isConfident(decision: Decision, threshold = DEFAULT_CONFIDENCE_THRESHOLD): boolean {
  return decision.probability >= threshold;
}
