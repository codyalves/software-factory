import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb, type FactoryDb } from './database.ts';
import { migrate } from './migrator.ts';

/**
 * Connection string for a server where the user can create databases. CI
 * provides one; Postgres integration tests are skipped without it.
 */
export const TEST_DATABASE_URL = process.env.FACTORY_TEST_DB;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

export interface TestDatabase extends FactoryDb {
  /** Connection URL of this database, as its owner. */
  readonly url: string;
  /** Runs SQL as the database owner, e.g. to simulate tampering. */
  exec(sqlText: string): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** A fresh, migrated database, dropped on dispose. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) {
    throw new Error('FACTORY_TEST_DB is not set');
  }

  const name = `factory_test_${randomUUID().replaceAll('-', '')}`;
  await admin(`create database ${name}`);

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  // The drop below terminates idle connections on purpose.
  const factoryDb = createDb(url.toString(), { onIdleError: () => {} });
  await migrate(factoryDb.pool, MIGRATIONS_DIR);

  const dispose = async () => {
    await factoryDb.close();
    await admin(`drop database if exists ${name} with (force)`);
  };

  return {
    ...factoryDb,
    url: url.toString(),
    close: dispose,
    exec: async (sqlText) => {
      await factoryDb.pool.query(sqlText);
    },
    [Symbol.asyncDispose]: dispose,
  };
}

async function admin(sqlText: string): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sqlText);
  } finally {
    await client.end();
  }
}
