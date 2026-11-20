import { MAX_IMPLEMENT_ATTEMPTS } from './run-state-machine.ts';
import { RISK_TIERS, type RiskTier } from './triage.ts';

/**
 * The implement-and-gate loop's rules: what the work must satisfy, whether a
 * set of gate results lets it through, and what the implementer is told when
 * it does not. Pure functions; the orchestrator applies them.
 */

export interface AcceptanceCriterion {
  /** AC-1, AC-2, ... in the order the issue lists them. */
  readonly id: string;
  readonly text: string;
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;

/**
 * The issue's acceptance criteria: its bullet and numbered lines, in order.
 * Triage has already judged that these are specific and testable; numbering
 * them gives every criterion an id that tests, commits and the audit log can
 * refer to.
 */
export function extractCriteria(body: string): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  // Bullets inside code blocks and HTML comments are content, not criteria.
  const prose = body.replace(/<!--[\s\S]*?-->/g, '').replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  for (const line of prose.split(/\r?\n/)) {
    const text = BULLET.exec(line)?.[1];
    if (text) {
      criteria.push({ id: `AC-${criteria.length + 1}`, text });
    }
  }
  return criteria;
}

export interface GateResult {
  readonly gate: string;
  readonly passed: boolean;
  /** One line a person can read in a list. */
  readonly summary: string;
  /** The end of the command output or the findings, for the implementer. */
  readonly details?: string;
}

export type GatingOutcome =
  | { readonly next: 'Reviewing'; readonly reason: string }
  | { readonly next: 'Implementing'; readonly reason: string; readonly feedback: string }
  | { readonly next: 'Escalated'; readonly reason: string; readonly comment: string };

const FEEDBACK_LIMIT = 12_000;

/**
 * Every gate is required: one red gate sends the work back with the failures
 * as feedback, and once the attempts are spent a person takes over. No model
 * output can turn a red gate green.
 */
export function gatingOutcome(
  results: readonly GateResult[],
  implementAttempts: number,
  maxAttempts: number = MAX_IMPLEMENT_ATTEMPTS,
): GatingOutcome {
  if (results.length === 0) {
    throw new Error('gating produced no results');
  }
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    return { next: 'Reviewing', reason: `all ${results.length} gates passed` };
  }

  const names = failed.map((r) => r.gate).join(', ');
  if (implementAttempts >= maxAttempts) {
    return {
      next: 'Escalated',
      reason: `gates still failing after ${implementAttempts} attempts: ${names}`,
      comment: [
        `The software factory made ${implementAttempts} attempts at this issue and could not get every quality gate to pass.`,
        '',
        ...failed.map((r) => `- **${r.gate}**: ${r.summary}`),
        '',
        'A person needs to take it from here. The full gate output is in the run audit log.',
      ].join('\n'),
    };
  }

  return {
    next: 'Implementing',
    reason: `gates failed: ${names}`,
    feedback: implementationFeedback(failed),
  };
}

/**
 * Sent with every return: without it a retry grows, fixing whatever it
 * notices on the way, and the correction becomes a diff nobody asked for.
 */
export const SCOPE_LINE =
  'Scope: change only what fixes these failures and meets the acceptance criteria. Do not refactor, reformat or fix unrelated code, and keep the rest of the previous attempt as it is.';

/** What the implementer is told about failed gates, bounded in size. */
export function implementationFeedback(failed: readonly GateResult[]): string {
  const share = Math.floor(FEEDBACK_LIMIT / Math.max(failed.length, 1));
  const sections = failed.map((r) => {
    const details = r.details ? tail(r.details, share) : '';
    return [`### Gate failed: ${r.gate}`, r.summary, details ? `\n\`\`\`\n${details}\n\`\`\`` : ''].join(
      '\n',
    );
  });
  return [
    'The previous attempt did not pass these quality gates. Fix the causes; do not weaken the gates.',
    '',
    SCOPE_LINE,
    '',
    ...sections,
  ]
    .join('\n')
    .trim();
}

function tail(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `[...${text.length - limit} characters omitted]\n${text.slice(-limit)}`;
}

/* ---------------------------------------------------------------- built-in gates */

/** Gates every attempt faces, whatever the target; the target adds its own commands. */
export const BUILT_IN_GATES = ['changes', 'protected_paths', 'secret_scan', 'traceability'] as const;

export interface ChangedFile {
  readonly path: string;
  /** Lines the change adds, with their line numbers in the new file. */
  readonly addedLines: readonly { readonly line: number; readonly text: string }[];
}

const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripe secret key', pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/ },
  {
    name: 'hard-coded credential',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  },
];

/** Looks for credentials in the lines a change adds. Reports where, never the value. */
export function secretScan(files: readonly ChangedFile[]): GateResult {
  const findings: string[] = [];
  for (const file of files) {
    for (const { line, text } of file.addedLines) {
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(text)) findings.push(`${file.path}:${line}: looks like a ${name}`);
      }
    }
  }
  return findings.length === 0
    ? { gate: 'secret_scan', passed: true, summary: 'no credentials in added lines' }
    : {
        gate: 'secret_scan',
        passed: false,
        summary: `${findings.length} possible credential(s) in added lines`,
        details: `${findings.join('\n')}\nRead secrets from configuration; never commit them.`,
      };
}

/** Converts a path glob (`**`, `*`, `?`) to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      // "**/" matches zero or more directories; a trailing "**" matches anything.
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Files the implementer may not change: CI, the target's own quality-gate
 * configuration, dependency manifests. Changing them needs a person, so the
 * agent cannot weaken a gate to get through it.
 */
export function protectedPathsGate(
  changedPaths: readonly string[],
  protectedGlobs: readonly string[],
): GateResult {
  const patterns = protectedGlobs.map((g) => ({ glob: g, re: globToRegExp(g) }));
  const hits = changedPaths.flatMap((path) => {
    const match = patterns.find((p) => p.re.test(path));
    return match ? [`${path} (protected by ${match.glob})`] : [];
  });
  return hits.length === 0
    ? { gate: 'protected_paths', passed: true, summary: 'no protected files changed' }
    : {
        gate: 'protected_paths',
        passed: false,
        summary: `changed ${hits.length} protected file(s)`,
        details: `${hits.join('\n')}\nRevert these changes. If the issue truly needs them, a person must make them.`,
      };
}

export function changesGate(changedPaths: readonly string[]): GateResult {
  return changedPaths.length > 0
    ? { gate: 'changes', passed: true, summary: `${changedPaths.length} file(s) changed` }
    : {
        gate: 'changes',
        passed: false,
        summary: 'the attempt changed no files',
        details: 'Implement the acceptance criteria; an empty change cannot pass.',
      };
}

/** The lines of a test file that count as this run's work, with their line numbers. */
export interface TestFile {
  readonly path: string;
  readonly lines: readonly { readonly line: number; readonly text: string }[];
}

export interface TraceLink {
  readonly criterionId: string;
  /** path:line of a test that names the criterion. */
  readonly testId: string;
}

/** Test files by the usual naming conventions. */
export function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/.test(path);
}

/**
 * The test lines a run wrote: the lines its change adds to test files. Ids
 * like AC-1 repeat across issues, so a test that was already there belongs to
 * some earlier issue and cannot stand for this one's criteria.
 */
export function testsAddedBy(changes: readonly ChangedFile[]): TestFile[] {
  return changes
    .filter((file) => isTestFile(file.path) && file.addedLines.length > 0)
    .map((file) => ({ path: file.path, lines: file.addedLines }));
}

/**
 * Every acceptance criterion must be named by at least one test this run
 * wrote (or the tester's regression test for it), by its id in the test's
 * name (`it('AC-2: rejects an empty email', ...)`). The links become the run's
 * traceability record: requirement -> criterion -> test -> commit.
 */
export function traceabilityGate(
  criteria: readonly AcceptanceCriterion[],
  tests: readonly TestFile[],
): { readonly result: GateResult; readonly links: readonly TraceLink[] } {
  const links: TraceLink[] = [];
  for (const criterion of criteria) {
    // AC-1 must not match AC-10.
    const mention = new RegExp(`\\b${criterion.id}\\b(?!\\d)`);
    for (const file of tests) {
      for (const { line, text } of file.lines) {
        if (mention.test(text)) links.push({ criterionId: criterion.id, testId: `${file.path}:${line}` });
      }
    }
  }
  const missing = criteria.filter((c) => !links.some((l) => l.criterionId === c.id));
  const result: GateResult =
    missing.length === 0
      ? {
          gate: 'traceability',
          passed: true,
          summary: `all ${criteria.length} criteria named by a test`,
        }
      : {
          gate: 'traceability',
          passed: false,
          summary: `${missing.length} of ${criteria.length} criteria have no test`,
          details: [
            'Each acceptance criterion needs a test, written for this issue, whose name starts with its id, for example',
            `it('${missing[0]?.id}: ...', ...). Tests that were already in the repository do not count. Missing:`,
            ...missing.map((c) => `- ${c.id}: ${c.text}`),
          ].join('\n'),
        };
  return { result, links };
}

/* ---------------------------------------------------------------- measured risk */

/** Path globs, per target, whose change makes work riskier than it may look from the issue. */
export interface RiskPaths {
  readonly high: readonly string[];
  readonly medium: readonly string[];
}

export interface MeasuredRisk {
  readonly tier: RiskTier;
  /** Which changed paths set the tier, e.g. "db/migrations/0002.sql matches db/** (high)". */
  readonly reasons: readonly string[];
}

/**
 * Risk from what the change actually touched, not what triage predicted from
 * the issue text. Triage is a model's guess made before any code exists; this
 * is computed from the diff, so no model can talk its way into a safer lane.
 */
export function measureRisk(changedPaths: readonly string[], riskPaths: RiskPaths): MeasuredRisk {
  const reasons: string[] = [];
  let tier: RiskTier = 'low';
  for (const level of ['high', 'medium'] as const) {
    const patterns = riskPaths[level].map((glob) => ({ glob, re: globToRegExp(glob) }));
    for (const path of changedPaths) {
      const match = patterns.find((p) => p.re.test(path));
      if (match) {
        reasons.push(`${path} matches ${match.glob} (${level})`);
        tier = higherTier(tier, level);
      }
    }
  }
  return { tier, reasons };
}

export function higherTier(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_TIERS.indexOf(a) >= RISK_TIERS.indexOf(b) ? a : b;
}

/* ---------------------------------------------------------------- delivery */

/**
 * Risk levels the factory may merge and ship without a person, once every
 * gate has passed. High risk (auth, data, payments, platform, migrations)
 * waits for the owner's approval. Pinned to gates/gates.yaml.
 */
export const AUTO_MERGE_RISK_LEVELS: readonly RiskTier[] = ['low', 'medium'];

export type DeliveryDecision =
  | { readonly next: 'Merging'; readonly reason: string }
  | { readonly next: 'Reviewing'; readonly reason: string };

/** What happens to work that passed every gate: the factory merges it, or a person reviews it. */
export function deliveryDecision(
  risk: RiskTier,
  autoMergeLevels: readonly RiskTier[] = AUTO_MERGE_RISK_LEVELS,
): DeliveryDecision {
  return autoMergeLevels.includes(risk)
    ? { next: 'Merging', reason: `${risk} risk: merges once the target's CI passes` }
    : { next: 'Reviewing', reason: `${risk} risk: held for the owner's approval` };
}

/** A pull request as the merge step sees it. */
export interface PullRequestStatus {
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly mergeSha: string | null;
  /** The target's CI on the head commit: pending until every check has finished. */
  readonly checks: 'pending' | 'success' | 'failure';
  readonly failingChecks: readonly string[];
}

export type MergeProgress =
  | { readonly done: false }
  | { readonly done: true; readonly merged: true; readonly mergeSha: string }
  | { readonly done: true; readonly merged: false; readonly reason: string };

/**
 * Where a merge stands. GitHub merges the pull request itself once the
 * target's required checks pass; the factory only watches. A failing check,
 * or a pull request closed without merging, ends the wait.
 */
export function mergeProgress(status: PullRequestStatus | null): MergeProgress {
  if (!status) return { done: false };
  if (status.state === 'merged') {
    return status.mergeSha ? { done: true, merged: true, mergeSha: status.mergeSha } : { done: false };
  }
  if (status.state === 'closed') {
    return { done: true, merged: false, reason: 'the pull request was closed without merging' };
  }
  if (status.checks === 'failure') {
    const names = status.failingChecks.length > 0 ? status.failingChecks.join(', ') : 'unknown';
    return { done: true, merged: false, reason: `the target's CI failed: ${names}` };
  }
  return { done: false };
}

/* ---------------------------------------------------------------- after the merge */

export type DeployState = 'none' | 'pending' | 'success' | 'failure';

export type PostDeployDecision =
  | { readonly action: 'continue'; readonly reason: string }
  | { readonly action: 'revert'; readonly reason: string }
  | { readonly action: 'stop'; readonly reason: string };

/**
 * What happens after shipped work reaches production. The tester crawls the
 * live site once the deploy succeeds; anything it confirms is new reverts the
 * change, and the factory stops shipping until a person looks. A deploy that
 * failed, or never finished, also stops it: shipping more onto a broken
 * pipeline only hides the cause.
 */
export function postDeployDecision(deploy: DeployState, newFindings: number): PostDeployDecision {
  if (deploy === 'failure') return { action: 'stop', reason: 'the production deploy failed' };
  if (deploy !== 'success') return { action: 'stop', reason: 'the production deploy did not finish in time' };
  if (newFindings > 0) {
    return {
      action: 'revert',
      reason: `the tester confirmed ${newFindings} new problem${newFindings === 1 ? '' : 's'} on production`,
    };
  }
  return { action: 'continue', reason: 'production is live and the tester found nothing new' };
}
