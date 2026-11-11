/**
 * Checks the factory database without changing any records: applies pending
 * migrations (the only write), verifies the audit chain, counts what is
 * stored, and checks the dashboard's read-only role if it exists. Prints a
 * Markdown report. Never prints the connection string.
 *
 *   DATABASE_URL=postgres://... node apps/workers/src/check-database.ts
 */
import { AuditStore, createDb, migrate } from '@factory/db';
import { sql } from 'kysely';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

const { db, pool, close } = createDb(url);
const lines: string[] = ['## Factory database check', ''];
let ok = true;

try {
  const { rows: version } = await sql<{
    version: string;
  }>`select current_setting('server_version') as version`.execute(db);
  lines.push(`- Connected: PostgreSQL ${version[0]?.version}`);

  await migrate(pool, process.env.MIGRATIONS_DIR ?? 'db/migrations');
  const { rows: applied } = await sql<{
    n: string;
  }>`select count(*)::text as n from schema_migrations`.execute(db);
  lines.push(`- Migrations applied: ${applied[0]?.n}`);

  const count = async (table: string) =>
    Number(
      (await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(db)).rows[0]
        ?.n ?? 0,
    );
  lines.push(
    `- Stored: ${await count('requirement')} requirements, ${await count('run')} runs, ${await count('audit_event')} audit events, ${await count('trace_link')} trace links`,
  );

  const problems = await new AuditStore(db).verifyInDatabase();
  ok &&= problems.length === 0;
  lines.push(`- Audit chain: ${problems.length === 0 ? 'verifies' : `**${problems.length} problems**`}`);

  const { rows: role } = await sql<{ select: boolean; insert: boolean; read_only: boolean }>`
    select has_table_privilege('factory_dashboard', 'run', 'select') as select,
           has_table_privilege('factory_dashboard', 'run', 'insert') as insert,
           coalesce((select 'default_transaction_read_only=on' = any(setconfig)
                     from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                     where r.rolname = 'factory_dashboard'), false) as read_only
    where exists (select 1 from pg_roles where rolname = 'factory_dashboard')
  `.execute(db);
  const r = role[0];
  if (!r) {
    lines.push('- Dashboard role: not created yet (see docs/hosting.md)');
  } else {
    const good = r.select && !r.insert && r.read_only;
    ok &&= good;
    lines.push(
      `- Dashboard role: ${good ? 'reads, cannot write' : `**misconfigured** (select ${r.select}, insert ${r.insert}, read-only ${r.read_only})`}`,
    );
  }
} catch (error) {
  ok = false;
  // pg error messages do not include the password.
  lines.push(`- **Failed:** ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await close();
}

console.log(lines.join('\n'));
process.exit(ok ? 0 : 1);
