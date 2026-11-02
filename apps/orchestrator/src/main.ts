import { createDb, RunStore, StepQueue } from '@factory/db';
import { z } from 'zod';
import { runIntakeLoop } from './intake-loop.ts';
import { runPeriodically } from './periodic.ts';

const config = z
  .object({
    DATABASE_URL: z.url(),
    IDLE_DELAY_MS: z.coerce.number().int().positive().default(5_000),
    REAP_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  })
  .parse(process.env);

const { db, close } = createDb(config.DATABASE_URL);
const queue = new StepQueue(db);
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

console.info('orchestrator started');
await Promise.all([
  runIntakeLoop({
    runs: new RunStore(db),
    idleDelayMs: config.IDLE_DELAY_MS,
    signal: controller.signal,
    log: console,
  }),
  // Steps whose worker crashed or hung get their lease taken back and are
  // retried (or dead-lettered) like any other transient failure.
  runPeriodically(
    'lease reaper',
    async () => {
      const reaped = await queue.reapExpiredLeases();
      if (reaped > 0) console.info(`reclaimed ${reaped} step(s) with expired leases`);
    },
    { intervalMs: config.REAP_INTERVAL_MS, signal: controller.signal, log: console },
  ),
]);
await close();
console.info('orchestrator stopped');
