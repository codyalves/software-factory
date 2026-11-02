import { type Decision, RISK_QUESTIONS, triageOutcome } from '@factory/domain';
import { describe, expect, it } from 'vitest';
import type { GoldenCase } from './golden.ts';
import { renderCaseDetails, renderReport, summarize } from './score.ts';

const THRESHOLD = 0.8;

const labels = {
  issue_type: ['feature'],
  spec_ready: ['yes'],
  risk_auth: ['no'],
  risk_data: ['no'],
  risk_payments: ['no'],
  risk_platform: ['no'],
  risk_existing_behavior: ['no'],
};

function golden(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: 'case',
    title: 't',
    body: 'b',
    labels,
    next: ['Planning'],
    tier: ['low'],
    why: 'w',
    ...overrides,
  };
}

function run(g: GoldenCase, answers: Record<string, readonly [string, number]> = {}) {
  const all: Record<string, readonly [string, number]> = {
    issue_type: ['feature', 0.95],
    spec_ready: ['yes', 0.95],
    ...Object.fromEntries(Object.values(RISK_QUESTIONS).map((q) => [q.name, ['no', 0.95] as const])),
    ...answers,
  };
  const decisions: Decision[] = Object.entries(all).map(([question, [choice, probability]]) => ({
    question,
    choice,
    probability,
    engine: 'test',
    engineVersion: '1',
    promptVersion: null,
    questionVersion: null,
  }));
  return { golden: g, decisions, outcome: triageOutcome(decisions, THRESHOLD) };
}

describe('summarize', () => {
  it('scores a perfect run as safe and fully correct', () => {
    const summary = summarize([run(golden())], THRESHOLD);

    expect(summary).toMatchObject({ cases: 1, routedCorrectly: 1, tierCorrect: 1, unsafe: 0, problems: [] });
    expect(summary.questions.find((q) => q.question === 'risk_auth')).toMatchObject({
      scored: 1,
      correct: 1,
      confidentWrong: 0,
    });
  });

  it('counts planning an issue that should have been escalated as unsafe', () => {
    const summary = summarize([run(golden({ next: ['Escalated'], tier: undefined }))], THRESHOLD);

    expect(summary.unsafe).toBe(1);
    expect(summary.problems).toEqual([
      { id: 'case', kind: 'planned-when-it-should-not', detail: 'went to Planning, expected Escalated' },
    ]);
  });

  it('counts a confidently missed risk as underrated and unsafe', () => {
    const g = golden({ labels: { ...labels, risk_auth: ['yes'] }, tier: ['high'] });

    const summary = summarize([run(g)], THRESHOLD);

    expect(summary.unsafe).toBe(1);
    expect(summary.problems[0]).toMatchObject({ kind: 'risk-underrated' });
    expect(summary.questions.find((q) => q.question === 'risk_auth')).toMatchObject({ confidentWrong: 1 });
  });

  it('treats an overcautious tier as a mismatch but not unsafe', () => {
    const summary = summarize([run(golden(), { risk_data: ['no', 0.5] })], THRESHOLD);

    expect(summary).toMatchObject({ unsafe: 0, tierCorrect: 0, casesWithFallbacks: 1 });
    expect(summary.problems[0]).toMatchObject({ kind: 'risk-overrated' });
  });

  it('skips questions whose label accepts every option', () => {
    const g = golden({ labels: { ...labels, spec_ready: ['yes', 'no'] } });

    const summary = summarize([run(g)], THRESHOLD);

    expect(summary.questions.find((q) => q.question === 'spec_ready')?.scored).toBe(0);
  });

  it('scores calibration with the Brier score', () => {
    const summary = summarize([run(golden(), { risk_auth: ['yes', 0.6] })], THRESHOLD);

    // Wrong at 0.6: (0.6 - 0)^2
    expect(summary.questions.find((q) => q.question === 'risk_auth')?.brier).toBeCloseTo(0.36, 9);
  });
});

describe('renderReport', () => {
  it('leads with unsafe outcomes and lists mismatches', () => {
    const summary = summarize([run(golden({ next: ['Rejected'], tier: undefined }))], THRESHOLD);

    const report = renderReport(summary, {
      model: 'claude-haiku-5-5',
      prompt: 'triage.v2@abc',
      threshold: THRESHOLD,
      spentUsd: 0.0123,
      errors: [],
    });

    expect(report).toContain('**Unsafe outcomes: 1**');
    expect(report).toContain('| case | planned-when-it-should-not |');
    expect(report).toContain('$0.0123');
  });
});

describe('renderCaseDetails', () => {
  it('explains each imperfect case and skips the perfect ones', () => {
    const details = renderCaseDetails(
      [
        run(golden({ id: 'perfect' })),
        run(golden({ id: 'missed', next: ['Planning', 'Escalated'] }), {
          spec_ready: ['no', 0.9],
          risk_data: ['no', 0.5],
        }),
      ],
      THRESHOLD,
    );

    expect(details).not.toContain('| perfect |');
    expect(details).toContain(
      '| missed | Escalated, high | spec_ready: no at 0.90 (label yes) | risk_data no below confidence threshold; treated as yes |',
    );
  });

  it('marks unsure misses and prints nothing for a clean run', () => {
    expect(renderCaseDetails([run(golden())], THRESHOLD)).toBe('');
    expect(renderCaseDetails([run(golden(), { risk_auth: ['yes', 0.6] })], THRESHOLD)).toContain(
      'risk_auth: yes at 0.60, unsure (label no)',
    );
  });
});
