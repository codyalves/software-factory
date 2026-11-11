import { createHash } from 'node:crypto';

/**
 * What the tester can report, and how a report becomes an issue the dev loop
 * can work on. Pure; the tester app gathers the evidence.
 *
 * Phase 1 categories are all machine-checkable: no model decides what is a bug.
 */
export const FINDING_CATEGORIES = [
  'page_error',
  'console_error',
  'http_error',
  'broken_link',
  'accessibility',
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
export type FindingSeverity = 'high' | 'medium' | 'low';

export interface Finding {
  readonly category: FindingCategory;
  /** Path of the page where it shows, e.g. "/about"; for a broken link, the link target. */
  readonly page: string;
  /** One line, for the issue title. */
  readonly summary: string;
  /** What identifies this problem across runs: messages, URLs or an accessibility rule. */
  readonly signature: string;
  readonly severity: FindingSeverity;
  /** What was observed, for the issue body. Never secrets: pages are public. */
  readonly evidence: string;
}

const CATEGORY_LABEL: Readonly<Record<FindingCategory, string>> = {
  page_error: 'Uncaught error',
  console_error: 'Console error',
  http_error: 'Failed request',
  broken_link: 'Broken link',
  accessibility: 'Accessibility',
};

/**
 * Strips what changes between runs (numbers, hashes, query strings, line and
 * column positions, build ids) so the same problem gets the same fingerprint.
 */
export function normalizeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[?#][^\s"')]*/g, '')
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/:\d+(:\d+)?\b/g, '')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable id for a finding: the same problem on the same page always matches. */
export function findingFingerprint(finding: Pick<Finding, 'category' | 'page' | 'signature'>): string {
  return createHash('sha256')
    .update(`${finding.category}\n${finding.page}\n${normalizeSignature(finding.signature)}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export interface ReproTest {
  /** tests/regressions/<name>.spec.ts in the target repository. */
  readonly path: string;
  readonly content: string;
}

export const REGRESSION_DIR = 'tests/regressions';
const REPRO_PATH = /^tests\/regressions\/[a-z0-9][a-z0-9-]{0,80}\.spec\.ts$/;

export function isReproPath(path: string): boolean {
  return REPRO_PATH.test(path);
}

const FINGERPRINT_MARK = /<!-- software-factory:finding fingerprint=([0-9a-f]{16}) -->/;
const REPRO_BLOCK =
  /<!-- software-factory:repro path=(\S+) -->\s*```(?:ts|typescript)\n([\s\S]*?)\n```\s*<!-- \/software-factory:repro -->/;

/**
 * The issue the tester files. Its only acceptance criterion is that the repro
 * test passes; the test is embedded so the dev loop can commit it before the
 * implementer starts, and the implementer may not change it.
 */
export function findingIssue(
  finding: Finding,
  repro: ReproTest,
  confirmation: { readonly runs: number; readonly failures: number },
): { title: string; body: string; labels: string[] } {
  const fingerprint = findingFingerprint(finding);
  const title = `${CATEGORY_LABEL[finding.category]} on ${finding.page}: ${finding.summary}`.slice(0, 120);
  const body = [
    `The factory's tester found this on \`${finding.page}\` and confirmed it: the test below failed ${confirmation.failures} of ${confirmation.runs} runs against \`main\`.`,
    '',
    `Severity: ${finding.severity}.`,
    '',
    '### Evidence',
    '',
    '```text',
    finding.evidence.trim().slice(0, 6_000),
    '```',
    '',
    '### Acceptance criteria',
    '',
    `- \`${repro.path}\` passes without changing it`,
    '',
    '### Regression test',
    '',
    'Committed to the fix branch before any code changes, and protected: the fix has to make it pass as written.',
    '',
    `<!-- software-factory:repro path=${repro.path} -->`,
    '```ts',
    repro.content.trimEnd(),
    '```',
    '<!-- /software-factory:repro -->',
    '',
    `<!-- software-factory:finding fingerprint=${fingerprint} -->`,
  ].join('\n');
  return { title, body, labels: ['found-by-tester', `severity:${finding.severity}`] };
}

export function parseFingerprint(body: string): string | null {
  return FINGERPRINT_MARK.exec(body)?.[1] ?? null;
}

/** The embedded regression test, if the body carries a well-formed one. */
export function parseRepro(body: string): ReproTest | null {
  const match = REPRO_BLOCK.exec(body);
  if (!match?.[1] || match[2] === undefined || !isReproPath(match[1])) return null;
  return { path: match[1], content: `${match[2]}\n` };
}
