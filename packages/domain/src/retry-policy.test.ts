import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  decideRetry,
  type FailureClass,
  DEFAULT_RETRY_POLICY as policy,
} from './retry-policy.ts';

describe('classifyFailure', () => {
  it.each<[number, FailureClass]>([
    [429, 'transient'],
    [408, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [401, 'permanent'],
    [404, 'permanent'],
    [422, 'permanent'],
  ])('HTTP %i is %s', (status, expected) => {
    expect(classifyFailure({ status })).toBe(expected);
  });

  it('classifies errors', () => {
    expect(classifyFailure({ error: new DOMException('slow', 'TimeoutError') })).toBe('timeout');
    expect(classifyFailure({ error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })).toBe(
      'transient',
    );
    expect(
      classifyFailure({ error: new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) }),
    ).toBe('transient');
    expect(classifyFailure({ error: new Error('bad config') })).toBe('permanent');
  });
});

describe('decideRetry', () => {
  it('never retries permanent failures', () => {
    expect(decideRetry(policy, 'permanent', 1).retry).toBe(false);
  });

  it('retries a timeout once', () => {
    expect(decideRetry(policy, 'timeout', 1).retry).toBe(true);
    expect(decideRetry(policy, 'timeout', 2).retry).toBe(false);
  });

  it('stops transient retries at max attempts', () => {
    expect(decideRetry(policy, 'transient', policy.maxAttempts - 1).retry).toBe(true);
    expect(decideRetry(policy, 'transient', policy.maxAttempts).retry).toBe(false);
  });

  it('keeps jittered delays within the exponential ceiling', () => {
    for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      for (const r of [0, 0.25, 0.999]) {
        const decision = decideRetry(policy, 'transient', attempt, undefined, () => r);
        expect(decision.retry && decision.delayMs).toBeGreaterThanOrEqual(0);
        expect(decision.retry && decision.delayMs).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('never undercuts Retry-After', () => {
    expect(decideRetry(policy, 'transient', 1, 30_000, () => 0)).toEqual({
      retry: true,
      delayMs: 30_000,
      reason: 'transient failure, attempt 1',
    });
  });
});
