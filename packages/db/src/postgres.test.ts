import type { ForgeIssue } from '@factory/domain';
import { describe, expect, it } from 'vitest';
import { AuditStore } from './audit-store.ts';
import { migrate } from './migrator.ts';
import { RunStore } from './run-store.ts';
import { createTestDatabase, MIGRATIONS_DIR, TEST_DATABASE_URL } from './testing.ts';

const issue: ForgeIssue = {
  repo: 'codyalves/target',
  number: 12,
  title: 'Fix the footer',
  body: 'It overlaps on mobile.',
  labels: ['factory'],
};

describe.skipIf(!TEST_DATABASE_URL)('Postgres integration', () => {
  it('turns issue intake into a run with a verifiable audit trail', async () => {
    await using t = await createTestDatabase();
    const runs = new RunStore(t.db);
    const audit = new AuditStore(t.db);

    const result = await runs.createFromIssue(issue, 'github', 'delivery-1');

    expect(result.outcome).toBe('created');
    const runId = result.outcome === 'created' ? result.runId : '';
    expect(await runs.get(runId)).toMatchObject({ state: 'Intake', implementAttempts: 0 });
    expect((await audit.readAll()).map((e) => e.type)).toEqual(['requirement.received', 'run.created']);
    expect(await audit.verify()).toMatchObject({ valid: true, eventCount: 2 });
    expect(await audit.verifyInDatabase()).toEqual([]);
  });

  it('keeps microsecond timestamps so app-side verification matches Postgres', async () => {
    await using t = await createTestDatabase();
    await new RunStore(t.db).createFromIssue(issue, 'github', 'delivery-1');

    const [first] = await new AuditStore(t.db).readAll();

    expect(first?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it('ignores a redelivered webhook', async () => {
    await using t = await createTestDatabase();
    const runs = new RunStore(t.db);

    await runs.createFromIssue(issue, 'github', 'delivery-1');
    const again = await runs.createFromIssue(issue, 'github', 'delivery-1');

    expect(again.outcome).toBe('duplicate-delivery');
    expect(await new AuditStore(t.db).readAll()).toHaveLength(2);
  });

  it('does not start a second run for an active requirement', async () => {
    await using t = await createTestDatabase();
    const runs = new RunStore(t.db);

    await runs.createFromIssue(issue, 'github', 'delivery-1');
    const second = await runs.createFromIssue(issue, 'github', 'delivery-2');

    expect(second.outcome).toBe('already-active');
  });

  it('records each state transition', async () => {
    await using t = await createTestDatabase();
    const runs = new RunStore(t.db);
    await runs.createFromIssue(issue, 'github', 'delivery-1');

    const moved = await runs.advanceNext('Intake', 'Triage', 'test');
    const nothingLeft = await runs.advanceNext('Intake', 'Triage', 'test');

    expect(moved?.state).toBe('Triage');
    expect(nothingLeft).toBeNull();
    const last = (await new AuditStore(t.db).readAll()).at(-1);
    expect(last?.type).toBe('run.state_changed');
    expect(JSON.parse(last?.payload ?? '{}')).toMatchObject({ from: 'Intake', to: 'Triage' });
  });

  it('lets only one of two concurrent orchestrators claim a run', async () => {
    await using t = await createTestDatabase();
    const runs = new RunStore(t.db);
    await runs.createFromIssue(issue, 'github', 'delivery-1');

    const results = await Promise.all([
      runs.advanceNext('Intake', 'Triage', 'a'),
      runs.advanceNext('Intake', 'Triage', 'b'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await new AuditStore(t.db).verifyInDatabase()).toEqual([]);
  });

  it('blocks updates, deletes and truncates on the audit log', async () => {
    await using t = await createTestDatabase();
    await new RunStore(t.db).createFromIssue(issue, 'github', 'delivery-1');

    await expect(t.exec(`update audit_event set type = 'x' where seq = 1`)).rejects.toThrow(/append-only/);
    await expect(t.exec('delete from audit_event where seq = 1')).rejects.toThrow(/append-only/);
    await expect(t.exec('truncate audit_event')).rejects.toThrow(/append-only/);
  });

  it('pinpoints tampering by a privileged user', async () => {
    await using t = await createTestDatabase();
    const audit = new AuditStore(t.db);
    await new RunStore(t.db).createFromIssue(issue, 'github', 'delivery-1');

    // An owner can switch the trigger off. The hash chain is what still catches it.
    await t.exec(`
      alter table audit_event disable trigger audit_event_no_update_or_delete;
      update audit_event set payload = '{"forged":true}' where seq = 1;
      alter table audit_event enable trigger audit_event_no_update_or_delete;
    `);

    expect(await audit.verify()).toMatchObject({ valid: false, brokenAtSeq: 1 });
    expect(await audit.verifyInDatabase()).toEqual([{ seq: 1, problem: 'hash does not match contents' }]);
  });

  it('refuses a migration that was edited after it was applied', async () => {
    await using t = await createTestDatabase();
    await t.exec(`update schema_migrations set checksum = repeat('f', 64) where version = '0001_init'`);

    await expect(migrate(t.pool, MIGRATIONS_DIR)).rejects.toThrow(/edited after it was applied/);
  });
});
