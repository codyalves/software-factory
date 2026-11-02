import { createDb, RunStore, StepQueue } from '@factory/db';
import { DEFAULT_CONFIDENCE_THRESHOLD } from '@factory/domain';
import { z } from 'zod';
import { runDrainLoop } from './drain-loop.ts';
import { runPeriodically } from './periodic.ts';
import { applyNextTriageResult, startNextTriage } from './triage.ts';

const config = z
  .object({
    DATABASE_URL: z.url(),
    IDLE_DELAY_MS: z.coerce.number().int().positive().default(5_000),
    REAP_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(DEFAULT_CONFIDENCE_THRESHOLD),
  })
  .parse(process.env);

const { db, close } = createDb(config.DATABASE_URL);
const runs = new RunStore(db);
const queue = new StepQueue(db);
const controller = new AbortController();
const loop = { idleDelayMs: config.IDLE_DELAY_MS, signal: controller.signal, log: console };

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

console.info('orchestrator started');
await Promise.all([
  runDrainLoop({ name: 'intake', next: () => startNextTriage(runs), ...loop }),
  runDrainLoop({
    name: 'triage results',
    next: () => applyNextTriageResult(runs, config.CONFIDENCE_THRESHOLD),
    ...loop,
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
