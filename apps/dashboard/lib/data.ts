import { createDb, FactoryControl, type FactoryDb, ReportStore } from '@factory/db';

// One pool per server process, kept across hot reloads in development.
const cache = globalThis as { factoryDb?: FactoryDb };

function db(): FactoryDb {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at the factory database, ideally as a read-only role.',
    );
  }
  // Serverless instances are many and short-lived: a few connections each.
  cache.factoryDb ??= createDb(url, { maxConnections: 3 });
  return cache.factoryDb;
}

/** Read-only views of the factory's record. */
export function reports(): ReportStore {
  return new ReportStore(db().db);
}

/** Only status() is used: the dashboard never pauses, resumes or changes budgets. */
export function factoryStatus() {
  return new FactoryControl(db().db).status();
}
