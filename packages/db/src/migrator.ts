import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

const MIGRATION_LOCK_KEY = 0x5f_ac_70_12;

/**
 * Applies db/migrations/*.sql in name order, each in its own transaction,
 * recording a checksum so an edited migration is caught instead of skipped.
 * Returns the versions applied by this call.
 */
export async function migrate(pool: pg.Pool, migrationsDir: string): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const client = await pool.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        version    text primary key,
        checksum   char(64) not null,
        applied_at timestamptz not null default now())`);

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const migration = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(migration, 'utf8').digest('hex');

      await client.query('begin');
      try {
        // Two instances starting together must not both apply a migration.
        await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

        const existing = await client.query<{ checksum: string }>(
          'select checksum from schema_migrations where version = $1',
          [version],
        );
        const recorded = existing.rows[0]?.checksum;

        if (recorded !== undefined) {
          await client.query('rollback');
          if (recorded.trim() !== checksum) {
            throw new Error(
              `Migration ${version} was edited after it was applied. Add a new migration instead.`,
            );
          }
          continue;
        }

        // No parameters: sent as a simple query, so a file may hold many statements.
        await client.query(migration);
        await client.query('insert into schema_migrations (version, checksum) values ($1, $2)', [
          version,
          checksum,
        ]);
        await client.query('commit');
        applied.push(version);
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    }
  } finally {
    client.release();
  }

  return applied;
}
