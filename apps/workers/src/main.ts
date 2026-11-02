import { hostname } from 'node:os';
import { createDb, StepQueue } from '@factory/db';
import { z } from 'zod';
import { handlers } from './handlers.ts';
import { runSteps } from './step-runner.ts';

const config = z
  .object({
    DATABASE_URL: z.url(),
    WORKER_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
    LEASE_MS: z.coerce.number().int().positive().default(60_000),
    IDLE_DELAY_MS: z.coerce.number().int().positive().default(2_000),
  })
  .parse(process.env);

const { db, close } = createDb(config.DATABASE_URL);
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

console.info(`worker ${config.WORKER_ID} started; handles: ${Object.keys(handlers).join(', ') || 'none'}`);
await runSteps({
  queue: new StepQueue(db),
  worker: config.WORKER_ID,
  handlers,
  leaseMs: config.LEASE_MS,
  idleDelayMs: config.IDLE_DELAY_MS,
  signal: controller.signal,
  log: console,
});
await close();
console.info(`worker ${config.WORKER_ID} stopped`);
