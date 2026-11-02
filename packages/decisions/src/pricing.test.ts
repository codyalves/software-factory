import { describe, expect, it } from 'vitest';
import { priceUsd } from './pricing.ts';

describe('priceUsd', () => {
  it('prices a short Haiku prompt at the base rate', () => {
    expect(priceUsd('claude-haiku-5-5', 50_000, 10_000)).toBeCloseTo(0.005 + 0.005, 9);
  });

  it('switches Haiku to the long-prompt rate above 100k input tokens', () => {
    expect(priceUsd('claude-haiku-5-5', 100_000, 0)).toBeCloseTo(0.01, 9);
    expect(priceUsd('claude-haiku-5-5', 200_000, 10_000)).toBeCloseTo(0.1 + 0.025, 9);
  });

  it('prices a dated snapshot like its model', () => {
    expect(priceUsd('claude-sonnet-5-5-20260901', 1_000_000, 0)).toBe(2);
  });

  it('charges an unknown model the most expensive rate, so the budget errs toward stopping', () => {
    expect(priceUsd('some-new-model', 1_000_000, 1_000_000)).toBe(60);
  });
});
