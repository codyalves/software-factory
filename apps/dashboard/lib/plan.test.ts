import { describe, expect, it } from 'vitest';
import { checkPlan, criteriaLines, dependsOnFor, fileable, type Plan, parsePlan, withoutIssue } from './plan';

const issue = (overrides: Record<string, unknown> = {}) => ({
  title: 'Search results page',
  description: 'Build the page the top bar search sends visitors to.',
  criteria: ['`/cards?q=t:instant` lists the matching cards, each linking to its card page'],
  dependsOn: [],
  ...overrides,
});

const planJson = (issues: unknown[]) => JSON.stringify({ summary: 'Split by page.', issues });

describe('parsePlan', () => {
  it('reads a plan whose dependencies point at earlier issues', () => {
    const plan = parsePlan(planJson([issue(), issue({ title: 'Card page', dependsOn: [0, 0] })]));

    expect(plan?.issues.map((i) => i.dependsOn)).toEqual([[], [0]]);
  });

  it('refuses a dependency on the same or a later issue, so filing in order always works', () => {
    expect(parsePlan(planJson([issue({ dependsOn: [0] })]))).toBeNull();
    expect(parsePlan(planJson([issue({ dependsOn: [1] }), issue()]))).toBeNull();
  });

  it('refuses malformed answers, empty plans and plans too big to review', () => {
    expect(parsePlan('not json')).toBeNull();
    expect(parsePlan(JSON.stringify({ issues: [] }))).toBeNull();
    expect(parsePlan(planJson([]))).toBeNull();
    expect(parsePlan(planJson(Array.from({ length: 9 }, () => issue())))).toBeNull();
    expect(parsePlan(planJson([issue({ criteria: 'one string' })]))).toBeNull();
  });
});

describe('checkPlan', () => {
  it('applies the request form rules to every planned issue', () => {
    const plan = parsePlan(planJson([issue(), issue({ description: '- a bullet\n- another' })])) as Plan;

    const checks = checkPlan(plan);

    expect(checks[0]?.error).toBeNull();
    expect(checks[1]?.error).toMatch(/prose/);
    expect(fileable(checks)).toBe(false);
  });

  it('flags criteria a test cannot pin down without blocking the plan', () => {
    const plan = parsePlan(
      planJson([issue({ criteria: ['The search page looks modern and clean'] })]),
    ) as Plan;

    const [check] = checkPlan(plan);

    expect(check?.vague).toHaveLength(1);
    expect(fileable(checkPlan(plan))).toBe(true);
  });
});

describe('dependsOnFor', () => {
  it('turns plan positions into the numbers the issues were filed as', () => {
    const plan = parsePlan(planJson([issue(), issue(), issue({ dependsOn: [0, 1] })])) as Plan;

    expect(dependsOnFor(plan.issues[2] as Plan['issues'][number], [31, 32], [12])).toBe('12 31 32');
  });

  it('refuses to file an issue before the ones it depends on', () => {
    const plan = parsePlan(planJson([issue(), issue({ dependsOn: [0] })])) as Plan;

    expect(() => dependsOnFor(plan.issues[1] as Plan['issues'][number], [])).toThrow(/not been filed/);
  });
});

describe('editing a plan', () => {
  it('removes an issue and keeps the others pointing at the same work', () => {
    const plan = parsePlan(
      planJson([issue({ title: 'A' }), issue({ title: 'B' }), issue({ title: 'C', dependsOn: [0, 1] })]),
    ) as Plan;

    const edited = withoutIssue(plan.issues, 0);

    expect(edited.map((i) => [i.title, i.dependsOn])).toEqual([
      ['B', []],
      ['C', [0]],
    ]);
  });

  it('reads criteria typed one per line, with or without bullets', () => {
    expect(criteriaLines('- First thing\n\n2. Second thing\n  Third  ')).toEqual([
      'First thing',
      'Second thing',
      'Third',
    ]);
  });
});
