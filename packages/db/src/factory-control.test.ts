import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { AuditStore } from './audit-store.ts';
import { assertTimeZone, FactoryControl } from './factory-control.ts';
import { RunStore } from './run-store.ts';
import { StepQueue } from './step-queue.ts';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './testing.ts';

async function newStep(t: TestDatabase) {
  const run = await new RunStore(t.db).createFromIssue(
    { repo: 'codyalves/target', number: 1, title: 't', body: '', labels: ['factory'] },
    'github',
    'd-1',
  );
  if (run.outcome !== 'created') throw new Error('expected a run');
  const { stepId } = await new StepQueue(t.db).enqueue({
    runId: run.runId,
    kind: 'triage',
    idempotencyKey: 'k',
  });
  return { id: stepId, runId: run.runId };
}

const usage = (usd: number) => ({ model: 'claude-haiku-5-5', inputTokens: 1000, outputTokens: 50, usd });

describe('assertTimeZone', () => {
  it('accepts IANA zones and rejects anything else', () => {
    expect(() => assertTimeZone('America/Chicago')).not.toThrow();
    expect(() => assertTimeZone('Mars/Olympus')).toThrow(RangeError);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('factory control', () => {
  it('starts paused, so nothing spends until a person resumes it', async () => {
    await using t = await createTestDatabase();
    const control = new FactoryControl(t.db);

    expect(await control.status()).toMatchObject({
      paused: true,
      dailyBudgetUsd: 3,
      budgetTimeZone: 'UTC',
      spentTodayUsd: 0,
      remainingTodayUsd: 3,
    });
    expect(await control.allowsWork()).toMatchObject({ ok: false });
    expect(await control.allowsSending()).toMatchObject({ ok: false });
  });

  it('records who paused and resumed, and why, in the audit chain', async () => {
    await using t = await createTestDatabase();
    const control = new FactoryControl(t.db);

    await control.resume('codyalves');
    expect(await control.allowsWork()).toEqual({ ok: true });
    await control.pause('codyalves', 'done for the day');

    expect(await control.allowsWork()).toEqual({
      ok: false,
      reason: 'paused by codyalves: done for the day',
    });
    const events = await new AuditStore(t.db).readAll();
    expect(events.map((e) => [e.type, JSON.parse(e.payload)])).toEqual([
      ['factory.resumed', { actor: 'codyalves', reason: null, wasPaused: true }],
      ['factory.paused', { actor: 'codyalves', reason: 'done for the day', wasPaused: false }],
    ]);
    expect(await new AuditStore(t.db).verifyInDatabase()).toEqual([]);
  });

  it('stops work once today’s ledger reaches the budget', async () => {
    await using t = await createTestDatabase();
    const control = new FactoryControl(t.db);
    const queue = new StepQueue(t.db);
    const step = await newStep(t);
    await control.resume('codyalves');
    await control.setBudget('codyalves', 0.01);

    await queue.recordUsage(step, [usage(0.004), usage(0.004)]);
    expect(await control.allowsWork()).toEqual({ ok: true });
    expect((await control.status()).spentTodayUsd).toBeCloseTo(0.008, 6);

    await queue.recordUsage(step, [usage(0.003)]);
    const blocked = await control.allowsWork();
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.reason).toMatch(/^daily budget reached/);
    // The budget only gates new work; sends still go out.
    expect(await control.allowsSending()).toEqual({ ok: true });
    expect((await control.status()).remainingTodayUsd).toBe(0);
  });

  it('counts only spend since midnight in the budget time zone', async () => {
    await using t = await createTestDatabase();
    const control = new FactoryControl(t.db);
    const step = await newStep(t);
    await sql`
      insert into cost_ledger (run_id, step_id, model, usd, at)
      values (${step.runId}::uuid, ${step.id}::uuid, 'claude-haiku-5-5', 1.5, now() - interval '2 days')
    `.execute(t.db);
    await new StepQueue(t.db).recordUsage(step, [usage(0.25)]);

    expect((await control.status()).spentTodayUsd).toBeCloseTo(0.25, 6);
  });

  it('audits budget changes and rejects bad values', async () => {
    await using t = await createTestDatabase();
    const control = new FactoryControl(t.db);

    const status = await control.setBudget('codyalves', 1.5, 'America/New_York');

    expect(status).toMatchObject({ dailyBudgetUsd: 1.5, budgetTimeZone: 'America/New_York' });
    await expect(control.setBudget('codyalves', -1)).rejects.toThrow(RangeError);
    await expect(control.setBudget('codyalves', 1, 'Nowhere/Land')).rejects.toThrow(RangeError);
    const events = await new AuditStore(t.db).readAll();
    expect(events.map((e) => [e.type, JSON.parse(e.payload)])).toEqual([
      [
        'factory.budget_changed',
        {
          actor: 'codyalves',
          from: { dailyBudgetUsd: '3.00', timeZone: 'UTC' },
          to: { dailyBudgetUsd: '1.50', timeZone: 'America/New_York' },
        },
      ],
    ]);
  });
});
