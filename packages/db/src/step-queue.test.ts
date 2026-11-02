import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AuditStore } from './audit-store.ts';
import { RunStore } from './run-store.ts';
import { StepQueue } from './step-queue.ts';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './testing.ts';

const LEASE_MS = 30_000;
/** No backoff, so a retried step is immediately claimable again. */
const instant = { policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } };

async function newRun(t: TestDatabase, deliveryId = 'd-1', issueNumber = 1): Promise<string> {
  const result = await new RunStore(t.db).createFromIssue(
    { repo: 'codyalves/target', number: issueNumber, title: 't', body: '', labels: ['factory'] },
    'github',
    deliveryId,
  );
  if (result.outcome !== 'created') throw new Error('expected a new run');
  return result.runId;
}

async function auditTypes(t: TestDatabase): Promise<string[]> {
  return (await new AuditStore(t.db).readAll()).map((e) => e.type);
}

describe.skipIf(!TEST_DATABASE_URL)('step queue', () => {
  it('runs a step from enqueue to success, with every transition audited', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db);
    const runId = await newRun(t);

    const { stepId } = await queue.enqueue({ runId, kind: 'triage', idempotencyKey: `${runId}:triage` });
    const claimed = await queue.claim('worker-a', ['triage'], LEASE_MS);

    expect(claimed).toMatchObject({ id: stepId, status: 'running', attempt: 1, leaseOwner: 'worker-a' });
    expect(await queue.complete(stepId, 'worker-a', { issueType: 'bug' })).toBe(true);
    expect(await queue.claim('worker-a', ['triage'], LEASE_MS)).toBeNull();
    expect((await auditTypes(t)).slice(-3)).toEqual(['step.enqueued', 'step.started', 'step.succeeded']);
    expect(await new AuditStore(t.db).verifyInDatabase()).toEqual([]);
  });

  it('treats a repeated enqueue with the same key as a no-op', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db);
    const runId = await newRun(t);

    const first = await queue.enqueue({ runId, kind: 'triage', idempotencyKey: 'k' });
    const second = await queue.enqueue({ runId, kind: 'triage', idempotencyKey: 'k' });

    expect(second).toEqual({ stepId: first.stepId, created: false });
  });

  it('only hands out steps of the requested kinds and only once they are due', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db);
    const runId = await newRun(t);
    await queue.enqueue({ runId, kind: 'gate', idempotencyKey: 'gate' });
    await queue.enqueue({ runId, kind: 'triage', idempotencyKey: 'later', delayMs: 60_000 });

    expect(await queue.claim('w', ['triage'], LEASE_MS)).toBeNull();
    expect(await queue.claim('w', ['gate'], LEASE_MS)).toMatchObject({ kind: 'gate' });
  });

  it('never gives the same step to two workers', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db);
    const runId = await newRun(t);
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ runId, kind: 'gate', idempotencyKey: `gate-${i}` });
    }

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => queue.claim(`worker-${i}`, ['gate'], LEASE_MS)),
    );
    const ids = claims.flatMap((c) => (c ? [c.id] : []));

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('retries a transient failure with backoff, then succeeds', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db, {
      policy: { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 },
      random: () => 0.5,
    });
    const runId = await newRun(t);
    const { stepId } = await queue.enqueue({ runId, kind: 'gate', idempotencyKey: 'g' });

    await queue.claim('w', ['gate'], LEASE_MS);
    const decision = await queue.fail(stepId, 'w', { failureClass: 'transient', message: 'HTTP 503' });

    expect(decision).toMatchObject({ retry: true, delayMs: 30_000 });
    // Backing off: not claimable yet.
    expect(await queue.claim('w', ['gate'], LEASE_MS)).toBeNull();
    await t.exec(`update step set run_after = now() where id = '${stepId}'`);
    expect(await queue.claim('w', ['gate'], LEASE_MS)).toMatchObject({ attempt: 2 });
  });

  it('dead-letters a permanent failure immediately, keeping the failure details', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db, instant);
    const runId = await newRun(t);
    const { stepId } = await queue.enqueue({ runId, kind: 'gate', idempotencyKey: 'g' });

    await queue.claim('w', ['gate'], LEASE_MS);
    const decision = await queue.fail(stepId, 'w', {
      failureClass: 'permanent',
      message: 'repository not found',
      details: { status: 404 },
    });

    expect(decision).toEqual({ retry: false, reason: 'permanent failure' });
    const [deadLetter] = await queue.listDeadLetters();
    expect(deadLetter).toMatchObject({
      step: { id: stepId, status: 'dead_lettered', attempt: 1 },
      failureClass: 'permanent',
      lastError: 'repository not found',
      attempts: [
        {
          attempt: 1,
          worker: 'w',
          outcome: 'dead_lettered',
          failureClass: 'permanent',
          error: { message: 'repository not found', worker: 'w', details: { status: 404 } },
        },
      ],
    });
    expect((await auditTypes(t)).at(-1)).toBe('step.dead_lettered');
  });

  it('dead-letters after the last allowed attempt', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db, instant);
    const runId = await newRun(t);
    const { stepId } = await queue.enqueue({ runId, kind: 'gate', idempotencyKey: 'g', maxAttempts: 2 });

    await queue.claim('w', ['gate'], LEASE_MS);
    expect((await queue.fail(stepId, 'w', { failureClass: 'transient', message: 'x' }))?.retry).toBe(true);
    await queue.claim('w', ['gate'], LEASE_MS);
    expect((await queue.fail(stepId, 'w', { failureClass: 'transient', message: 'x' }))?.retry).toBe(false);

    const [deadLetter] = await queue.listDeadLetters();
    expect(deadLetter?.attempts.map((a) => a.outcome)).toEqual(['retry_scheduled', 'dead_lettered']);
  });

  it('keeps a lease alive with heartbeats, and only for its owner', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db, instant);
    const runId = await newRun(t);
    const { stepId } = await queue.enqueue({ runId, kind: 'gate', idempotencyKey: 'g' });
    await queue.claim('owner', ['gate'], 50);

    expect(await queue.heartbeat(stepId, 'owner', LEASE_MS)).toBe(true);
    expect(await queue.heartbeat(stepId, 'impostor', LEASE_MS)).toBe(false);
    await sleep(80);
    expect(await queue.reapExpiredLeases()).toBe(0);
  });

  it('reclaims a step whose worker disappeared, and rejects that worker’s late result', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db, instant);
    const runId = await newRun(t);
    const { stepId } = await queue.enqueue({ runId, kind: 'gate', idempotencyKey: 'g' });
    await queue.claim('crashed-worker', ['gate'], 20);

    await sleep(60);
    expect(await queue.reapExpiredLeases()).toBe(1);

    expect(await queue.complete(stepId, 'crashed-worker', { late: true })).toBe(false);
    expect(await queue.heartbeat(stepId, 'crashed-worker', LEASE_MS)).toBe(false);
    expect(await queue.claim('healthy-worker', ['gate'], LEASE_MS)).toMatchObject({
      id: stepId,
      attempt: 2,
    });
  });

  it('replays a dead letter for one more attempt and records who did it', async () => {
    await using t = await createTestDatabase();
    const queue = new StepQueue(t.db, instant);
    const runId = await newRun(t);
    const { stepId } = await queue.enqueue({ runId, kind: 'gate', idempotencyKey: 'g', maxAttempts: 1 });
    await queue.claim('w', ['gate'], LEASE_MS);
    await queue.fail(stepId, 'w', { failureClass: 'transient', message: 'flaky' });

    expect(await queue.replay(stepId, 'codyalves')).toBe(true);
    expect(await queue.replay(stepId, 'codyalves')).toBe(false);
    expect(await queue.listDeadLetters()).toEqual([]);

    const events = await new AuditStore(t.db).readAll();
    const replayed = events.find((e) => e.type === 'step.replayed');
    expect(JSON.parse(replayed?.payload ?? '{}')).toMatchObject({ actor: 'codyalves', afterAttempt: 1 });
    expect(await queue.claim('w', ['gate'], LEASE_MS)).toMatchObject({ attempt: 2 });
  });
});
