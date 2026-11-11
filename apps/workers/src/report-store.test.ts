import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportStore } from '@factory/db';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '@factory/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTracedTest,
  CLEAR_ANSWERS,
  createTargetRepo,
  fixYear,
  runScenario,
  scripted,
} from './testing/scenario.ts';

const REPO = 'codyalves/target';
const body = '- The footer shows the current year\n- The year is not hard-coded';

describe.skipIf(!TEST_DATABASE_URL)('ReportStore over real runs', () => {
  let root: string;
  let remote: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'report-test-'));
    remote = await createTargetRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const issue = (number: number, title: string, issueBody = body) => ({
    repo: REPO,
    number,
    title,
    body: issueBody,
    labels: ['factory'],
  });

  async function shipped(t: TestDatabase) {
    return runScenario({
      db: t.db,
      remote,
      issue: issue(1, 'Footer shows last year'),
      answers: CLEAR_ANSWERS,
      implementer: scripted([fixYear, addTracedTest]),
    });
  }

  it('lists runs newest first with state, risk, attempts, spend and the pull request', async () => {
    await using t = await createTestDatabase();
    const first = await shipped(t);
    const second = await runScenario({
      db: t.db,
      remote,
      issue: issue(2, 'Write my essay', 'Need 1500 words on the French Revolution.'),
      answers: { ...CLEAR_ANSWERS, issue_type: ['reject', 0.96] },
      implementer: scripted([fixYear]),
    });

    const runs = await new ReportStore(t.db).listRuns();

    expect(runs.map((r) => r.id)).toEqual([second, first]);
    expect(runs[1]).toMatchObject({
      repo: REPO,
      issueNumber: 1,
      state: 'Reviewing',
      riskLevel: 'medium',
      implementAttempts: 2,
      budgetUsd: 5,
      pullRequestUrl: expect.stringMatching(/^https:\/\/github.com\/codyalves\/target\/pull\/\d+$/),
    });
    // Two implement attempts at $0.25 plus seven triage answers.
    expect(runs[1]?.spentUsd).toBeCloseTo(0.5 + 7 * 0.000105, 6);
    expect(runs[0]).toMatchObject({ state: 'Rejected', implementAttempts: 0, pullRequestUrl: null });
  });

  it('tells the whole story of one run', async () => {
    await using t = await createTestDatabase();
    const runId = await shipped(t);

    const report = await new ReportStore(t.db).runReport(runId);

    expect(report?.timeline.map((s) => `${s.from}>${s.to}`)).toEqual([
      'Intake>Triage',
      'Triage>Planning',
      'Planning>Implementing',
      'Implementing>Gating',
      'Gating>Implementing',
      'Implementing>Gating',
      'Gating>Reviewing',
    ]);
    expect(report?.decisions).toHaveLength(7);
    expect(report?.decisions[0]).toMatchObject({
      question: 'issue_type',
      choice: 'feature',
      probability: 0.94,
      confident: true,
      threshold: 0.8,
      promptVersion: 'triage.v3@scenario00000',
      questionVersion: expect.stringMatching(/^issue_type@[0-9a-f]{12}$/),
    });
    expect(report?.triage).toEqual({ riskFactors: [], fallbacks: [] });

    expect(report?.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(report?.attempts[0]?.gates.find((g) => g.gate === 'traceability')).toMatchObject({
      passed: false,
    });
    expect(report?.attempts[1]?.gates.every((g) => g.passed)).toBe(true);
    expect(report?.attempts[1]).toMatchObject({
      committed: true,
      implementer: 'scripted/claude-sonnet-5-5',
      commitSha: report?.headSha,
      risk: {
        predicted: 'low',
        measured: 'medium',
        final: 'medium',
        reasons: ['year.js matches year.js (medium)'],
      },
    });

    expect(report?.trace).toEqual([
      {
        criterionId: 'AC-1',
        criterion: 'The footer shows the current year',
        tests: [{ testId: 'year.test.js:4', commitSha: report?.headSha }],
      },
      {
        criterionId: 'AC-2',
        criterion: 'The year is not hard-coded',
        tests: [{ testId: 'year.test.js:7', commitSha: report?.headSha }],
      },
    ]);
    expect(report?.costByModel).toEqual([
      { model: 'claude-sonnet-5-5', usd: 0.5, calls: 2 },
      { model: 'claude-haiku-5-5', usd: expect.closeTo(7 * 0.000105, 6), calls: 7 },
    ]);
    expect(report?.messages).toEqual([
      { kind: 'pull_request.open', status: 'sent', url: report?.pullRequestUrl, error: null },
    ]);
    expect(report?.events.at(-1)?.type).toBe('outbox.sent');
  });

  it('shows why an escalated run stopped', async () => {
    await using t = await createTestDatabase();
    const runId = await runScenario({
      db: t.db,
      remote,
      issue: issue(3, 'Footer year, again'),
      answers: { ...CLEAR_ANSWERS, risk_data: ['no', 0.6] },
      implementer: scripted([fixYear]),
    });

    const report = await new ReportStore(t.db).runReport(runId);

    expect(report).toMatchObject({ state: 'Escalated', implementAttempts: 4, riskLevel: 'high' });
    expect(report?.triage?.fallbacks).toEqual(['risk_data no below confidence threshold; treated as yes']);
    expect(report?.attempts).toHaveLength(4);
    expect(report?.timeline.at(-1)?.reason).toBe('gates still failing after 4 attempts: traceability');
    expect(report?.messages).toEqual([
      { kind: 'issue.comment', status: 'sent', url: expect.any(String), error: null },
    ]);
  });

  it('returns nothing for an unknown or malformed run id', async () => {
    await using t = await createTestDatabase();
    const reports = new ReportStore(t.db);

    expect(await reports.runReport('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await reports.runReport("x' or 1=1 --")).toBeNull();
  });

  it('builds the traceability matrix across requirements', async () => {
    await using t = await createTestDatabase();
    const runId = await shipped(t);

    const matrix = await new ReportStore(t.db).traceMatrix();

    expect(matrix).toHaveLength(1);
    expect(matrix[0]).toMatchObject({
      repo: REPO,
      issueNumber: 1,
      latestRunId: runId,
      latestState: 'Reviewing',
      pullRequestUrl: expect.stringContaining('/pull/'),
    });
    expect(matrix[0]?.criteria.map((c) => [c.criterionId, c.tests.length])).toEqual([
      ['AC-1', 1],
      ['AC-2', 1],
    ]);
  });

  it('summarises and verifies the audit chain', async () => {
    await using t = await createTestDatabase();
    await shipped(t);

    const audit = await new ReportStore(t.db).auditSummary(5);

    expect(audit.problems).toEqual([]);
    expect(audit.events).toBeGreaterThan(20);
    expect(audit.recent).toHaveLength(5);
    expect(audit.recent[0]?.hash).toBe(audit.headHash);
    expect(audit.headHash).toMatch(/^[0-9a-f]{64}$/);

    // Tamper with history: verification must notice.
    await t.pool.query(`
      alter table audit_event disable trigger audit_event_no_update_or_delete;
      update audit_event set payload = '{"forged":true}' where seq = 3;
    `);
    expect((await new ReportStore(t.db).auditSummary()).problems).not.toEqual([]);
  });
});
