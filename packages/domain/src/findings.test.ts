import { describe, expect, it } from 'vitest';
import { extractCriteria } from './delivery.ts';
import {
  type Finding,
  findingFingerprint,
  findingIssue,
  isReproPath,
  normalizeSignature,
  parseFingerprint,
  parseRepro,
} from './findings.ts';

const finding: Finding = {
  category: 'page_error',
  page: '/about',
  summary: "TypeError: Cannot read properties of undefined (reading 'name')",
  signature:
    "TypeError: Cannot read properties of undefined (reading 'name') at https://x/_next/static/chunks/a1b2c3d4e5.js:12:345",
  severity: 'high',
  evidence:
    "TypeError: Cannot read properties of undefined (reading 'name')\n    at Footer (a1b2c3d4e5.js:12:345)",
};

const repro = {
  path: 'tests/regressions/about-page-error.spec.ts',
  content:
    "import { test, expect } from '@playwright/test';\n\ntest('AC-1: /about loads without uncaught errors', async () => {});\n",
};

describe('fingerprints', () => {
  it('ignore what changes between builds and runs', () => {
    expect(normalizeSignature('Failed at /static/chunk-9f8e7d6c5b.js:10:2?v=123')).toBe(
      normalizeSignature('Failed at /static/chunk-0a1b2c3d4e.js:88:7?v=456'),
    );
    expect(findingFingerprint(finding)).toBe(
      findingFingerprint({ ...finding, signature: finding.signature.replace('a1b2c3d4e5', 'ffee99887766') }),
    );
  });

  it('differ for a different page, category or message', () => {
    const base = findingFingerprint(finding);
    expect(findingFingerprint({ ...finding, page: '/' })).not.toBe(base);
    expect(findingFingerprint({ ...finding, category: 'console_error' })).not.toBe(base);
    expect(findingFingerprint({ ...finding, signature: 'ReferenceError: x is not defined' })).not.toBe(base);
  });
});

describe('findingIssue', () => {
  const issue = findingIssue(finding, repro, { runs: 3, failures: 3 });

  it('has one acceptance criterion: the repro test passes as written', () => {
    expect(extractCriteria(issue.body)).toEqual([
      { id: 'AC-1', text: '`tests/regressions/about-page-error.spec.ts` passes without changing it' },
    ]);
  });

  it('carries the test, the fingerprint and the evidence', () => {
    expect(parseRepro(issue.body)).toEqual(repro);
    expect(parseFingerprint(issue.body)).toBe(findingFingerprint(finding));
    expect(issue.body).toContain('failed 3 of 3 runs');
    expect(issue.title).toBe(
      "Uncaught error on /about: TypeError: Cannot read properties of undefined (reading 'name')",
    );
    expect(issue.labels).toEqual(['found-by-tester', 'severity:high']);
  });
});

describe('parseRepro', () => {
  it('rejects a test that would land outside tests/regressions', () => {
    const body = findingIssue(
      finding,
      { ...repro, path: 'tests/regressions/x.spec.ts' },
      { runs: 3, failures: 3 },
    ).body;
    expect(
      parseRepro(body.replaceAll('tests/regressions/x.spec.ts', '../../.github/workflows/ci.yml')),
    ).toBeNull();
    expect(isReproPath('tests/regressions/../x.spec.ts')).toBe(false);
    expect(isReproPath('tests/regressions/ok-name.spec.ts')).toBe(true);
  });

  it('finds nothing in an ordinary issue', () => {
    expect(parseRepro('- The footer shows the year')).toBeNull();
    expect(parseFingerprint('nothing here')).toBeNull();
  });
});

describe('extractCriteria', () => {
  it('ignores bullets inside code blocks and comments', () => {
    const body = [
      '- real one',
      '```text',
      '- not a criterion',
      '```',
      '<!-- - hidden -->',
      '* real two',
    ].join('\n');
    expect(extractCriteria(body).map((c) => c.text)).toEqual(['real one', 'real two']);
  });
});
