import { describe, expect, it } from 'vitest';
import type { Decision } from './decisions.ts';
import { RISK_QUESTIONS, TRIAGE_QUESTIONS, triageOutcome } from './triage.ts';

const THRESHOLD = 0.8;

type Answers = Record<string, readonly [string, number]>;

function decisions(answers: Answers): Decision[] {
  return Object.entries(answers).map(([question, [choice, probability]]) => ({
    question,
    choice,
    probability,
    engine: 'test',
    engineVersion: '1',
    promptVersion: null,
    questionVersion: null,
  }));
}

const noRisk: Answers = Object.fromEntries(
  Object.values(RISK_QUESTIONS).map((q) => [q.name, ['no', 0.95] as const]),
);

const clearFeature: Answers = {
  actionable: ['yes', 0.95],
  issue_type: ['feature', 0.95],
  spec_ready: ['yes', 0.9],
  ...noRisk,
};

const outcome = (overrides: Answers = {}) =>
  triageOutcome(decisions({ ...clearFeature, ...overrides }), THRESHOLD);

describe('triage questions', () => {
  it('asks actionable, type, spec and every risk factor, each with a unique name', () => {
    const names = TRIAGE_QUESTIONS.map((q) => q.name);

    expect(names.slice(0, 3)).toEqual(['actionable', 'issue_type', 'spec_ready']);
    expect(names).toHaveLength(3 + Object.keys(RISK_QUESTIONS).length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every risk question a plain yes/no', () => {
    for (const question of Object.values(RISK_QUESTIONS)) {
      expect(question.options).toEqual(['yes', 'no']);
    }
  });
});

describe('triageOutcome', () => {
  it('sends a clear, well-specified, low-risk issue to planning', () => {
    expect(outcome()).toEqual({
      next: 'Planning',
      riskTier: 'low',
      riskFactors: [],
      reason: 'triaged as feature, low risk',
      fallbacks: [],
      comment: null,
    });
  });

  it('rates a change to existing behavior as medium risk', () => {
    expect(outcome({ risk_existing_behavior: ['yes', 0.9] })).toMatchObject({
      riskTier: 'medium',
      riskFactors: ['risk_existing_behavior'],
      reason: 'triaged as feature, medium risk (risk_existing_behavior)',
    });
  });

  it('rates any high-risk factor as high, whatever else is true', () => {
    for (const question of Object.values(RISK_QUESTIONS).filter((q) => q.tier === 'high')) {
      expect(outcome({ [question.name]: ['yes', 0.99] }).riskTier).toBe('high');
    }
    expect(outcome({ risk_existing_behavior: ['yes', 0.9], risk_auth: ['yes', 0.9] })).toMatchObject({
      riskTier: 'high',
      riskFactors: ['risk_auth', 'risk_existing_behavior'],
    });
  });

  it('treats an unsure "no" as "yes", and says so', () => {
    expect(outcome({ risk_payments: ['no', 0.6] })).toMatchObject({
      next: 'Planning',
      riskTier: 'high',
      riskFactors: ['risk_payments'],
      fallbacks: ['risk_payments no below confidence threshold; treated as yes'],
    });
  });

  it('counts an unsure "yes" as a factor without calling it a fallback', () => {
    expect(outcome({ risk_existing_behavior: ['yes', 0.55] })).toMatchObject({
      riskTier: 'medium',
      fallbacks: [],
    });
  });

  it('rejects work that is confidently not actionable, and says so on the issue', () => {
    const rejected = outcome({ actionable: ['no', 0.9] });

    expect(rejected.next).toBe('Rejected');
    expect(rejected.comment).toContain('will not work on this issue');
  });

  it('escalates instead of rejecting, or starting, when "actionable" is unsure', () => {
    expect(outcome({ actionable: ['no', 0.6] })).toMatchObject({
      next: 'Escalated',
      fallbacks: ['actionable no below confidence threshold; escalated'],
    });
    expect(outcome({ actionable: ['yes', 0.6] }).next).toBe('Escalated');
  });

  it('records an unsure issue type and carries on, since every type takes the same path', () => {
    // A styling change can read as a feature or a chore; either way the loop is the same.
    expect(outcome({ issue_type: ['feature', 0.6] })).toMatchObject({
      next: 'Planning',
      reason: 'triaged as feature, low risk',
      fallbacks: ['issue_type feature below confidence threshold; recorded only'],
    });
  });

  it('asks for testable criteria when the spec is not ready', () => {
    const notReady = outcome({ spec_ready: ['no', 0.95] });

    expect(notReady).toMatchObject({ next: 'Escalated', fallbacks: [] });
    expect(notReady.comment).toContain('testable statement');
  });

  it('treats an unsure "spec ready" as not ready', () => {
    const unsure = outcome({ spec_ready: ['yes', 0.5] });

    expect(unsure.next).toBe('Escalated');
    expect(unsure.fallbacks).toEqual(['spec_ready yes below confidence threshold; treated as no']);
  });

  it('refuses to decide on missing or invalid answers', () => {
    const { risk_data: _omitted, ...withoutData } = clearFeature;

    expect(() => triageOutcome(decisions(withoutData), THRESHOLD)).toThrow(/risk_data/);
    expect(() => outcome({ risk_auth: ['maybe', 0.9] })).toThrow(/risk_auth/);
  });
});
