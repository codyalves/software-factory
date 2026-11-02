import { AuditStore, RunStore, StepQueue } from '@factory/db';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '@factory/db/testing';
import { type Decision, RISK_QUESTIONS } from '@factory/domain';
import { describe, expect, it } from 'vitest';
import { applyNextTriageResult, startNextTriage, TRIAGE_STEP } from './triage.ts';

const THRESHOLD = 0.8;

function decision(question: string, choice: string, probability: number): Decision {
  return {
    question,
    choice,
    probability,
    engine: 'test',
    engineVersion: '1',
    promptVersion: 'triage.v1@x',
    questionVersion: null,
  };
}

/** A full set of triage answers: a clear, low-risk feature unless overridden. */
function answers(overrides: Record<string, readonly [string, number]> = {}): Decision[] {
  const base: Record<string, readonly [string, number]> = {
    issue_type: ['feature', 0.95],
    spec_ready: ['yes', 0.9],
    ...Object.fromEntries(Object.values(RISK_QUESTIONS).map((q) => [q.name, ['no', 0.95] as const])),
    ...overrides,
  };
  return Object.entries(base).map(([question, [choice, probability]]) =>
    decision(question, choice, probability),
  );
}

/** Webhook intake, then the orchestrator queues triage. */
async function runAwaitingTriage(
  t: TestDatabase,
): Promise<{ runs: RunStore; queue: StepQueue; runId: string }> {
  const runs = new RunStore(t.db);
  const queue = new StepQueue(t.db, { policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
  const created = await runs.createFromIssue(
    {
      repo: 'codyalves/target',
      number: 42,
      title: 'Add a contact page',
      body: 'Form posts to /contact',
      labels: ['factory'],
    },
    'github',
    'd-1',
  );
  if (created.outcome !== 'created') throw new Error('expected a run');
  expect(await startNextTriage(runs)).toContain('triage step queued');
  return { runs, queue, runId: created.runId };
}

/** Stands in for a worker: claims the triage step and completes it with these decisions. */
async function workerAnswers(queue: StepQueue, decisions: Decision[]): Promise<void> {
  const step = await queue.claim('worker', [TRIAGE_STEP], 30_000);
  if (!step) throw new Error('triage step was not queued');
  await queue.complete(step.id, 'worker', { decisions });
}

async function outbox(t: TestDatabase) {
  return (await t.pool.query('select kind, payload from outbox order by id')).rows;
}

describe.skipIf(!TEST_DATABASE_URL)('triage through the orchestrator', () => {
  it('plans a clear issue, records each decision, and sets the risk tier', async () => {
    await using t = await createTestDatabase();
    const { runs, queue, runId } = await runAwaitingTriage(t);
    await workerAnswers(queue, answers());

    expect(await applyNextTriageResult(runs, THRESHOLD)).toBe(`run ${runId} triaged: Planning`);
    expect(await applyNextTriageResult(runs, THRESHOLD)).toBeNull();

    expect(await runs.get(runId)).toMatchObject({ state: 'Planning' });
    const risk = await t.pool.query('select risk_level from requirement');
    expect(risk.rows).toEqual([{ risk_level: 'low' }]);
    expect(await outbox(t)).toEqual([]);

    const events = await new AuditStore(t.db).readAll();
    expect(events.map((e) => e.type).slice(-10)).toEqual([
      'step.succeeded',
      ...Array(7).fill('decision.made'),
      'triage.completed',
      'run.state_changed',
    ]);
    const firstDecision = JSON.parse(events.find((e) => e.type === 'decision.made')?.payload ?? '{}');
    expect(firstDecision).toMatchObject({
      question: 'issue_type',
      choice: 'feature',
      confident: true,
      threshold: 0.8,
    });
    expect(await new AuditStore(t.db).verifyInDatabase()).toEqual([]);
  });

  it('escalates an issue without testable criteria and asks the author for them', async () => {
    await using t = await createTestDatabase();
    const { runs, queue, runId } = await runAwaitingTriage(t);
    await workerAnswers(queue, answers({ spec_ready: ['no', 0.92] }));

    await applyNextTriageResult(runs, THRESHOLD);

    expect(await runs.get(runId)).toMatchObject({ state: 'Escalated' });
    const [comment] = await outbox(t);
    expect(comment).toMatchObject({
      kind: 'issue.comment',
      payload: {
        repo: 'codyalves/target',
        issueNumber: 42,
        body: expect.stringContaining('testable statement'),
      },
    });
  });

  it('records the risk factors and the fallback when the model is unsure', async () => {
    await using t = await createTestDatabase();
    const { runs, queue } = await runAwaitingTriage(t);
    await workerAnswers(
      queue,
      answers({ issue_type: ['bug', 0.9], risk_existing_behavior: ['yes', 0.9], risk_data: ['no', 0.55] }),
    );

    await applyNextTriageResult(runs, THRESHOLD);

    const completed = (await new AuditStore(t.db).readAll()).find((e) => e.type === 'triage.completed');
    expect(JSON.parse(completed?.payload ?? '{}')).toMatchObject({
      next: 'Planning',
      riskTier: 'high',
      riskFactors: ['risk_data', 'risk_existing_behavior'],
      fallbacks: ['risk_data no below confidence threshold; treated as yes'],
    });
    const risk = await t.pool.query('select risk_level from requirement');
    expect(risk.rows).toEqual([{ risk_level: 'high' }]);
  });

  it('escalates the run when the triage step dead-letters', async () => {
    await using t = await createTestDatabase();
    const { runs, queue, runId } = await runAwaitingTriage(t);
    const step = await queue.claim('worker', [TRIAGE_STEP], 30_000);
    await queue.fail(step?.id ?? '', 'worker', { failureClass: 'permanent', message: 'invalid API key' });

    expect(await applyNextTriageResult(runs, THRESHOLD)).toBe(`run ${runId} triaged: Escalated`);
    const types = (await new AuditStore(t.db).readAll()).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['triage.failed', 'run.state_changed']);
  });

  it('waits while the triage step is still queued or running', async () => {
    await using t = await createTestDatabase();
    const { runs, queue } = await runAwaitingTriage(t);

    expect(await applyNextTriageResult(runs, THRESHOLD)).toBeNull();
    await queue.claim('worker', [TRIAGE_STEP], 30_000);
    expect(await applyNextTriageResult(runs, THRESHOLD)).toBeNull();
  });
});
