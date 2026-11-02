import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIDENCE_THRESHOLD } from '@factory/domain';
import { describe, expect, it } from 'vitest';
import { type GoldenCase, labelProblems, loadGoldenSet } from './golden.ts';

const GOLDEN = fileURLToPath(new URL('../../../../evals/triage/golden.json', import.meta.url));

describe('the triage golden set', () => {
  it('has about twenty cases with unique ids, covering every route and tier', async () => {
    const cases = await loadGoldenSet(GOLDEN);
    const ids = cases.map((c) => c.id);

    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ids).size).toBe(ids.length);
    for (const next of ['Planning', 'Escalated', 'Rejected'] as const) {
      expect(cases.some((c) => c.next.length === 1 && c.next[0] === next)).toBe(true);
    }
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(cases.some((c) => c.tier?.length === 1 && c.tier[0] === tier)).toBe(true);
    }
  });

  it('labels every question with valid answers that the triage rules turn into the expected outcome', async () => {
    const cases = await loadGoldenSet(GOLDEN);

    expect(cases.flatMap((c) => labelProblems(c, DEFAULT_CONFIDENCE_THRESHOLD))).toEqual([]);
  });
});

describe('labelProblems', () => {
  const base: GoldenCase = {
    id: 'x',
    title: 't',
    body: 'b',
    labels: {
      issue_type: ['feature'],
      spec_ready: ['yes'],
      risk_auth: ['no'],
      risk_data: ['no'],
      risk_payments: ['no'],
      risk_platform: ['no'],
      risk_existing_behavior: ['no'],
    },
    next: ['Planning'],
    tier: ['low'],
    why: 'w',
  };

  it('reports labels the rules would route somewhere else', () => {
    const problems = labelProblems({ ...base, next: ['Escalated'] }, 0.8);

    expect(problems).toEqual([expect.stringContaining('routes to Planning, not Escalated')]);
  });

  it('reports a tier the labels cannot produce', () => {
    const problems = labelProblems({ ...base, labels: { ...base.labels, risk_auth: ['yes', 'no'] } }, 0.8);

    expect(problems).toEqual([expect.stringContaining('risk_auth=yes')]);
  });

  it('reports invalid answers and missing questions', () => {
    const { risk_data: _omitted, ...labels } = base.labels;

    expect(labelProblems({ ...base, labels: { ...labels, risk_auth: ['maybe'] } }, 0.8)).toEqual([
      'x: risk_auth label "maybe" is not an option',
      'x: no label for risk_data',
    ]);
  });
});
