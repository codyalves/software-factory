import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, FactoryControl, ReportStore } from '@factory/db';
import { createTestDatabase, TEST_DATABASE_URL } from '@factory/db/testing';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  addTracedTest,
  CLEAR_ANSWERS,
  createTargetRepo,
  fixYear,
  runScenario,
  scripted,
} from './testing/scenario.ts';

const ROLE_SQL = fileURLToPath(new URL('../../../db/roles/dashboard-readonly.sql', import.meta.url));

/**
 * db/roles/dashboard-readonly.sql is what the dashboard logs in with when
 * hosted. Applied exactly as written (only the role name and password
 * substituted), it must show everything and change nothing.
 */
describe.skipIf(!TEST_DATABASE_URL)('the dashboard read-only role', () => {
  it('can render every dashboard view, and cannot write anything', async () => {
    await using t = await createTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'readonly-test-'));
    const role = `dash_${randomBytes(6).toString('hex')}`;
    const password = randomBytes(18).toString('hex');
    try {
      const remote = await createTargetRepo(root);
      const runId = await runScenario({
        db: t.db,
        remote,
        issue: { repo: 'demo/site', number: 1, title: 'Footer year', body: '- shows the year', labels: [] },
        answers: CLEAR_ANSWERS,
        implementer: scripted([fixYear, addTracedTest]),
      });

      const script = (await readFile(ROLE_SQL, 'utf8'))
        .replaceAll('factory_dashboard', role)
        .replace("'CHANGE_ME'", `'${password}'`);
      await t.exec(script);

      const url = new URL(t.url);
      url.username = role;
      url.password = password;
      const asDashboard = createDb(url.toString(), { onIdleError: () => {} });
      try {
        const reports = new ReportStore(asDashboard.db);
        expect(await reports.listRuns()).toHaveLength(1);
        expect((await reports.runReport(runId))?.state).toBe('Reviewing');
        expect(await reports.traceMatrix()).toHaveLength(1);
        expect((await reports.auditSummary()).problems).toEqual([]);
        expect((await new FactoryControl(asDashboard.db).status()).paused).toBe(false);

        // Writes fail, through the table grants and the read-only default.
        await expect(sql`update factory_control set paused = true`.execute(asDashboard.db)).rejects.toThrow(
          /read-only|permission denied/,
        );
        await expect(sql`select audit_append(null, 'forged', '{}')`.execute(asDashboard.db)).rejects.toThrow(
          /read-only|permission denied/,
        );
        await expect(sql`delete from run`.execute(asDashboard.db)).rejects.toThrow(
          /read-only|permission denied/,
        );
      } finally {
        await asDashboard.close();
      }
    } finally {
      await t.exec(`drop owned by ${role}; drop role if exists ${role};`).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
