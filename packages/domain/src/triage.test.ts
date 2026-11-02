import { describe, expect, it } from 'vitest';
import type { Decision } from './decisions.ts';
import { triageOutcome } from './triage.ts';

const THRESHOLD = 0.8;

function decisions(answers: Record<string, readonly [string, number]>): Decision[] {
  return Object.entries(answers).map(([question, [choice, probability]]) => ({
    question,
    choice,
    probability,
    engine: 'test',
    engineVersion: '1',
    promptVersion: null,
  }));
}

const clearFeature = {
  issue_type: ['feature', 0.95],
  spec_ready: ['yes', 0.9],
  risk_tier: ['low', 0.9],
} as const;

describe('triageOutcome', () => {
  it('sends a clear, well-specified issue to planning', () => {
    expect(triageOutcome(decisions({ ...clearFeature }), THRESHOLD)).toEqual({
      next: 'Planning',
      riskTier: 'low',
      reason: 'triaged as feature, low risk',
      fallbacks: [],
      comment: null,
    });
  });

  it('rejects a confidently rejected issue and says so on the issue', () => {
    const outcome = triageOutcome(decisions({ ...clearFeature, issue_type: ['reject', 0.9] }), THRESHOLD);

    expect(outcome.next).toBe('Rejected');
    expect(outcome.comment).toContain('will not work on this issue');
  });

  it('escalates instead of rejecting when the rejection is unsure', () => {
    const outcome = triageOutcome(decisions({ ...clearFeature, issue_type: ['reject', 0.6] }), THRESHOLD);

    expect(outcome.next).toBe('Escalated');
    expect(outcome.fallbacks).toEqual(['issue_type reject below confidence threshold; escalated']);
  });

  it('asks for testable criteria when the spec is not ready', () => {
    const outcome = triageOutcome(decisions({ ...clearFeature, spec_ready: ['no', 0.95] }), THRESHOLD);

    expect(outcome).toMatchObject({ next: 'Escalated', fallbacks: [] });
    expect(outcome.comment).toContain('testable statement');
  });

  it('treats an unsure "spec ready" as not ready', () => {
    const outcome = triageOutcome(decisions({ ...clearFeature, spec_ready: ['yes', 0.5] }), THRESHOLD);

    expect(outcome.next).toBe('Escalated');
    expect(outcome.fallbacks).toEqual(['spec_ready yes below confidence threshold; treated as no']);
  });

  it('treats an unsure risk tier as high, and still plans the work', () => {
    const outcome = triageOutcome(decisions({ ...clearFeature, risk_tier: ['low', 0.4] }), THRESHOLD);

    expect(outcome).toMatchObject({ next: 'Planning', riskTier: 'high' });
    expect(outcome.fallbacks).toEqual(['risk_tier low below confidence threshold; treated as high']);
  });

  it('refuses to decide on missing or invalid answers', () => {
    const { risk_tier: _omitted, ...withoutRisk } = clearFeature;

    expect(() => triageOutcome(decisions(withoutRisk), THRESHOLD)).toThrow(/risk_tier/);
    expect(() =>
      triageOutcome(decisions({ ...clearFeature, risk_tier: ['extreme', 0.9] }), THRESHOLD),
    ).toThrow(/risk_tier/);
  });
});
