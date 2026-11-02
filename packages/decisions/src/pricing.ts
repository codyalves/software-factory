/**
 * Claude API list prices in USD per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-02).
 * Update this table when prices change; the budget is only as good as it.
 */
interface Price {
  readonly input: number;
  readonly output: number;
  /** Haiku 5.5 charges more for prompts over 100k tokens. */
  readonly longPrompt?: { readonly threshold: number; readonly input: number; readonly output: number };
}

const PRICES: Readonly<Record<string, Price>> = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    longPrompt: { threshold: 100_000, input: 0.5, output: 2.5 },
  },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

/** Unknown models are charged at the most expensive rate, so the budget errs toward stopping. */
const UNKNOWN_MODEL: Price = { input: 10, output: 50 };

/**
 * Cost of one request. Output tokens include thinking tokens. Input tokens
 * should include cache reads and writes, which also count toward the prompt
 * length that selects Haiku's rate.
 */
export function priceUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);
  const rate = price.longPrompt && inputTokens > price.longPrompt.threshold ? price.longPrompt : price;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/** Exact id first, then a dated snapshot of a listed model (claude-haiku-5-5-20260901). */
function priceFor(model: string): Price {
  const exact = PRICES[model];
  if (exact) {
    return exact;
  }
  const base = Object.keys(PRICES).find((id) => model.startsWith(`${id}-`));
  return base ? (PRICES[base] ?? UNKNOWN_MODEL) : UNKNOWN_MODEL;
}
