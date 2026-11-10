import { describe, expect, it } from 'vitest';
import {
  changesGate,
  extractCriteria,
  type GateResult,
  gatingOutcome,
  globToRegExp,
  higherTier,
  isTestFile,
  measureRisk,
  protectedPathsGate,
  SCOPE_LINE,
  secretScan,
  traceabilityGate,
} from './delivery.ts';

const pass = (gate: string): GateResult => ({ gate, passed: true, summary: 'ok' });
const fail = (gate: string, details?: string): GateResult => ({
  gate,
  passed: false,
  summary: `${gate} failed`,
  ...(details ? { details } : {}),
});

describe('extractCriteria', () => {
  it('numbers bullet, numbered and checkbox lines in order', () => {
    const body = [
      'Some context.',
      '',
      '- Given a visitor, then the footer shows the year',
      '* second',
      '2. third',
      '- [ ] fourth',
      '  - nested fifth',
      'not a bullet',
    ].join('\n');

    expect(extractCriteria(body)).toEqual([
      { id: 'AC-1', text: 'Given a visitor, then the footer shows the year' },
      { id: 'AC-2', text: 'second' },
      { id: 'AC-3', text: 'third' },
      { id: 'AC-4', text: 'fourth' },
      { id: 'AC-5', text: 'nested fifth' },
    ]);
  });

  it('finds nothing in prose', () => {
    expect(extractCriteria('Make the chatbot smarter.')).toEqual([]);
  });
});

describe('gatingOutcome', () => {
  it('moves to review only when every gate passed', () => {
    expect(gatingOutcome([pass('lint'), pass('unit_tests')], 1)).toEqual({
      next: 'Reviewing',
      reason: 'all 2 gates passed',
    });
  });

  it('sends failures back to the implementer as feedback', () => {
    const outcome = gatingOutcome([pass('lint'), fail('unit_tests', 'expected 2025 to be 2026')], 1);

    expect(outcome.next).toBe('Implementing');
    expect(outcome.next === 'Implementing' && outcome.feedback).toContain('### Gate failed: unit_tests');
    expect(outcome.next === 'Implementing' && outcome.feedback).toContain('expected 2025 to be 2026');
    expect(outcome.next === 'Implementing' && outcome.feedback).not.toContain('lint');
  });

  it('escalates to a person once the attempts are spent', () => {
    const outcome = gatingOutcome([fail('traceability')], 4);

    expect(outcome).toMatchObject({
      next: 'Escalated',
      reason: 'gates still failing after 4 attempts: traceability',
    });
    expect(outcome.next === 'Escalated' && outcome.comment).toContain('**traceability**');
  });

  it('keeps the end of long output, where the errors are', () => {
    const outcome = gatingOutcome([fail('unit_tests', `${'x'.repeat(50_000)}THE ERROR`)], 1);

    const feedback = outcome.next === 'Implementing' ? outcome.feedback : '';
    expect(feedback.length).toBeLessThan(13_000);
    expect(feedback).toContain('THE ERROR');
    expect(feedback).toContain('characters omitted');
  });

  it('refuses to decide with no results', () => {
    expect(() => gatingOutcome([], 1)).toThrow();
  });
});

describe('secretScan', () => {
  it('flags credentials by location without repeating them', () => {
    const key = `sk-ant-${'a'.repeat(30)}`;
    const result = secretScan([
      { path: 'src/a.ts', addedLines: [{ line: 3, text: `const k = "${key}";` }] },
      { path: 'src/b.ts', addedLines: [{ line: 9, text: 'apiKey: "abcdefghijklmnop"' }] },
      { path: 'src/c.ts', addedLines: [{ line: 1, text: 'const year = new Date().getFullYear();' }] },
    ]);

    expect(result.passed).toBe(false);
    expect(result.details).toContain('src/a.ts:3: looks like a Anthropic API key');
    expect(result.details).toContain('src/b.ts:9: looks like a hard-coded credential');
    expect(result.details).not.toContain(key);
    expect(result.details).not.toContain('src/c.ts');
  });

  it('passes clean changes, including reading secrets from the environment', () => {
    expect(
      secretScan([{ path: 'a.ts', addedLines: [{ line: 1, text: 'const key = process.env.API_KEY;' }] }])
        .passed,
    ).toBe(true);
  });
});

describe('protected paths', () => {
  it('matches globs the way paths are written', () => {
    expect(globToRegExp('.github/**').test('.github/workflows/ci.yml')).toBe(true);
    expect(globToRegExp('**/vitest.config.*').test('vitest.config.ts')).toBe(true);
    expect(globToRegExp('**/vitest.config.*').test('apps/web/vitest.config.mts')).toBe(true);
    expect(globToRegExp('package.json').test('apps/web/package.json')).toBe(false);
    expect(globToRegExp('*.lock').test('a/b.lock')).toBe(false);
  });

  it('fails when the change touches a protected file', () => {
    const result = protectedPathsGate(
      ['src/footer.tsx', '.github/workflows/ci.yml'],
      ['.github/**', 'package.json'],
    );

    expect(result).toMatchObject({ passed: false, summary: 'changed 1 protected file(s)' });
    expect(result.details).toContain('.github/workflows/ci.yml (protected by .github/**)');
  });

  it('passes ordinary source changes', () => {
    expect(protectedPathsGate(['src/footer.tsx'], ['.github/**']).passed).toBe(true);
  });
});

describe('changesGate', () => {
  it('fails an empty attempt', () => {
    expect(changesGate([]).passed).toBe(false);
    expect(changesGate(['a.ts']).passed).toBe(true);
  });
});

describe('traceability', () => {
  const criteria = [
    { id: 'AC-1', text: 'shows the year' },
    { id: 'AC-2', text: 'uses the server clock' },
  ];

  it('recognizes test files by convention', () => {
    expect(isTestFile('src/footer.test.tsx')).toBe(true);
    expect(isTestFile('src/footer.spec.ts')).toBe(true);
    expect(isTestFile('src/__tests__/footer.ts')).toBe(true);
    expect(isTestFile('src/footer.tsx')).toBe(false);
  });

  it('links each criterion to the tests that name it', () => {
    const { result, links } = traceabilityGate(criteria, [
      {
        path: 'src/footer.test.tsx',
        content: "it('AC-1: shows the year', () => {});\nit('AC-2: uses the server clock', () => {});",
      },
    ]);

    expect(result.passed).toBe(true);
    expect(links).toEqual([
      { criterionId: 'AC-1', testId: 'src/footer.test.tsx:1' },
      { criterionId: 'AC-2', testId: 'src/footer.test.tsx:2' },
    ]);
  });

  it('names the criteria that have no test, and does not count AC-10 as AC-1', () => {
    const { result } = traceabilityGate(criteria, [
      { path: 'a.test.ts', content: "it('AC-10: other', ...)\nit('AC-2: x')" },
    ]);

    expect(result).toMatchObject({ passed: false, summary: '1 of 2 criteria have no test' });
    expect(result.details).toContain('- AC-1: shows the year');
  });
});

describe('measureRisk', () => {
  const riskPaths = { high: ['db/migrations/**', '**/auth/**'], medium: ['lib/**'] };

  it('is low when nothing risky was touched', () => {
    expect(measureRisk(['app/components/footer.tsx'], riskPaths)).toEqual({ tier: 'low', reasons: [] });
  });

  it('takes the highest tier any changed path reaches, and says which paths', () => {
    expect(measureRisk(['lib/copyright.ts', 'app/auth/session.ts', 'README.md'], riskPaths)).toEqual({
      tier: 'high',
      reasons: ['app/auth/session.ts matches **/auth/** (high)', 'lib/copyright.ts matches lib/** (medium)'],
    });
  });
});

describe('higherTier', () => {
  it('keeps the riskier of two tiers', () => {
    expect(higherTier('low', 'medium')).toBe('medium');
    expect(higherTier('high', 'low')).toBe('high');
    expect(higherTier('medium', 'medium')).toBe('medium');
  });
});

describe('scope on returns', () => {
  it('tells the next attempt to fix only what failed', () => {
    const outcome = gatingOutcome([fail('unit_tests')], 1);

    expect(outcome.next === 'Implementing' && outcome.feedback).toContain(SCOPE_LINE);
  });
});
