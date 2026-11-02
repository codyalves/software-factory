import { createDb, RunStore } from '@factory/db';
import { z } from 'zod';
import { runIntakeLoop } from './intake-loop.ts';

const config = z
  .object({
    DATABASE_URL: z.url(),
    IDLE_DELAY_MS: z.coerce.number().int().positive().default(5_000),
  })
  .parse(process.env);

const { db, close } = createDb(config.DATABASE_URL);
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

console.info('orchestrator started');
await runIntakeLoop({
  runs: new RunStore(db),
  idleDelayMs: config.IDLE_DELAY_MS,
  signal: controller.signal,
  log: console,
});
await close();
console.info('orchestrator stopped');
