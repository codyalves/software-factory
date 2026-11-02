import { setTimeout as sleep } from 'node:timers/promises';
import { AuditStore, RunStore, type Step, StepQueue } from '@factory/db';
import { createTestDatabase, TEST_DATABASE_URL } from '@factory/db/testing';
import { describe, expect, it, vi } from 'vitest';
import { executeStep, runSteps, StepError, type StepRunnerOptions } from './step-runner.ts';

const step: Step = {
  id: 's1',
  runId: 'r1',
  kind: 'gate',
  status: 'running',
  attempt: 1,
  maxAttempts: 5,
  timeoutMs: 1_000,
  payload: {},
  idempotencyKey: 'k',
  leaseOwner: 'w',
};

function options(overrides: Partial<StepRunnerOptions> = {}): StepRunnerOptions {
  return {
    worker: 'w',
    leaseMs: 30_000,
    idleDelayMs: 10,
    signal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    handlers: {},
    queue: {
      claim: vi.fn().mockResolvedValue(null),
      heartbeat: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue({ retry: true, delayMs: 0, reason: '' }),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe('executeStep', () => {
  it('completes the step with the handler result', async () => {
    const o = options({ handlers: { gate: async () => ({ passed: true }) } });

    await executeStep(step, o);

    expect(o.queue.complete).toHaveBeenCalledWith('s1', 'w', { passed: true });
  });

  it('reports a handler-declared permanent failure with its details', async () => {
    const o = options({
      handlers: {
        gate: async () => {
          throw new StepError('tests failed to compile', { failureClass: 'permanent', details: { exit: 2 } });
        },
      },
    });

    await executeStep(step, o);

    expect(o.queue.fail).toHaveBeenCalledWith('s1', 'w', {
      failureClass: 'permanent',
      message: 'tests failed to compile',
      details: { exit: 2 },
    });
  });

  it('classifies HTTP status and passes Retry-After through', async () => {
    const o = options({
      handlers: {
        gate: async () => {
          throw new StepError('rate limited', { status: 429, retryAfterMs: 20_000 });
        },
      },
    });

    await executeStep(step, o);

    expect(o.queue.fail).toHaveBeenCalledWith('s1', 'w', {
      failureClass: 'transient',
      message: 'rate limited',
      retryAfterMs: 20_000,
    });
  });

  it('times out a handler that ignores its abort signal', async () => {
    const o = options({ handlers: { gate: () => new Promise(() => {}) } });

    await executeStep({ ...step, timeoutMs: 30 }, o);

    expect(o.queue.fail).toHaveBeenCalledWith(
      's1',
      'w',
      expect.objectContaining({ failureClass: 'timeout' }),
    );
  });

  it('discards the result and reports nothing once the lease is lost', async () => {
    const queue = { ...options().queue, heartbeat: vi.fn().mockResolvedValue(false) };
    const o = options({
      queue,
      leaseMs: 30,
      handlers: {
        gate: async (_step, { signal }) => {
          await sleep(200, undefined, { signal });
          return 'too late';
        },
      },
    });

    await executeStep(step, o);

    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it('records billed usage even when the step fails', async () => {
    const usage = { model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 2, usd: 0.000002 };
    const o = options({
      handlers: {
        gate: async (_step, { recordUsage }) => {
          recordUsage(usage);
          throw new StepError('bad answer', { failureClass: 'permanent' });
        },
      },
    });

    await executeStep(step, o);

    expect(o.queue.recordUsage).toHaveBeenCalledWith(step, [usage]);
    expect(o.queue.fail).toHaveBeenCalled();
  });

  it('does not touch the ledger when nothing was billed', async () => {
    const o = options({ handlers: { gate: async () => null } });

    await executeStep(step, o);

    expect(o.queue.recordUsage).not.toHaveBeenCalled();
  });

  it('dead-letters a step kind with no handler', async () => {
    const o = options();

    await executeStep({ ...step, kind: 'unknown' }, o);

    expect(o.queue.fail).toHaveBeenCalledWith(
      's1',
      'w',
      expect.objectContaining({ failureClass: 'permanent' }),
    );
  });
});

describe('runSteps', () => {
  it('only claims the kinds it has handlers for, and stops on signal', async () => {
    const controller = new AbortController();
    const o = options({
      signal: controller.signal,
      handlers: { gate: async () => null, triage: async () => null },
    });
    vi.mocked(o.queue.claim).mockImplementation(async () => {
      controller.abort();
      return null;
    });

    await runSteps(o);

    expect(o.queue.claim).toHaveBeenCalledWith('w', ['gate', 'triage'], 30_000);
  });
});

describe('runSteps work gate', () => {
  it('claims nothing while the gate is closed, and logs the reason once', async () => {
    const controller = new AbortController();
    let checks = 0;
    const o = options({
      signal: controller.signal,
      handlers: { gate: async () => null },
      canClaim: async () => {
        if (++checks === 3) controller.abort();
        return { ok: false, reason: 'paused by cody' };
      },
    });

    await runSteps(o);

    expect(o.queue.claim).not.toHaveBeenCalled();
    expect(o.log.info).toHaveBeenCalledWith('not taking new work: paused by cody');
    expect(vi.mocked(o.log.info).mock.calls.filter(([m]) => String(m).startsWith('not taking'))).toHaveLength(
      1,
    );
  });

  it('treats a failed gate check as closed', async () => {
    const controller = new AbortController();
    const o = options({
      signal: controller.signal,
      handlers: { gate: async () => null },
      canClaim: async () => {
        controller.abort();
        throw new Error('db down');
      },
    });

    await runSteps(o);

    expect(o.queue.claim).not.toHaveBeenCalled();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('worker with Postgres', () => {
  it('retries a flaky step and completes it, leaving a valid audit trail', async () => {
    await using t = await createTestDatabase();
    const created = await new RunStore(t.db).createFromIssue(
      { repo: 'codyalves/target', number: 1, title: 't', body: '', labels: ['factory'] },
      'github',
      'd-1',
    );
    if (created.outcome !== 'created') throw new Error('expected a run');
    const queue = new StepQueue(t.db, { policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } });
    await queue.enqueue({ runId: created.runId, kind: 'gate', idempotencyKey: 'g' });

    let calls = 0;
    const controller = new AbortController();
    await runSteps({
      ...options({ signal: controller.signal }),
      queue,
      handlers: {
        gate: async () => {
          calls++;
          if (calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          controller.abort();
          return { passed: true };
        },
      },
    });

    const types = (await new AuditStore(t.db).readAll()).map((e) => e.type);
    expect(types.slice(2)).toEqual([
      'step.enqueued',
      'step.started',
      'step.retry_scheduled',
      'step.started',
      'step.succeeded',
    ]);
    expect(await new AuditStore(t.db).verifyInDatabase()).toEqual([]);
  });
});
