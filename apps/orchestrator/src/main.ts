import { readFileSync } from 'node:fs';
import { createDb, FactoryControl, OutboxRelay, RunStore, StepQueue } from '@factory/db';
import { DEFAULT_CONFIDENCE_THRESHOLD } from '@factory/domain';
import { GitHubAppAuth, GitHubForge, parsePrivateKey } from '@factory/github';
import { z } from 'zod';
import { applyNextGateResult, applyNextImplementation, startNextImplementation } from './delivery.ts';
import { runDrainLoop } from './drain-loop.ts';
import { deliverNextOutbox } from './outbox.ts';
import { runPeriodically } from './periodic.ts';
import { applyNextTriageResult, startNextTriage } from './triage.ts';

const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const config = z
  .object({
    DATABASE_URL: z.url(),
    IDLE_DELAY_MS: z.coerce.number().int().positive().default(5_000),
    REAP_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(DEFAULT_CONFIDENCE_THRESHOLD),
    // The factory's GitHub App. Without it the outbox relay is off and messages wait.
    GITHUB_APP_ID: optional,
    GITHUB_APP_PRIVATE_KEY: optional,
    GITHUB_APP_PRIVATE_KEY_FILE: optional,
  })
  .parse(process.env);

const { db, close } = createDb(config.DATABASE_URL);
const runs = new RunStore(db);
const queue = new StepQueue(db);
const control = new FactoryControl(db);
const controller = new AbortController();
const loop = { idleDelayMs: config.IDLE_DELAY_MS, signal: controller.signal, log: console };

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

const privateKeyPem =
  config.GITHUB_APP_PRIVATE_KEY ??
  (config.GITHUB_APP_PRIVATE_KEY_FILE ? readFileSync(config.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8') : undefined);

const auth =
  config.GITHUB_APP_ID && privateKeyPem
    ? new GitHubAppAuth({ appId: config.GITHUB_APP_ID, privateKey: parsePrivateKey(privateKeyPem) })
    : null;
const forge = auth ? new GitHubForge({ auth }) : null;
// Only issues the factory's own App opened may carry a protected regression test.
const trustedAuthors = auth ? [await auth.botLogin()] : [];

console.info(`orchestrator started; outbox relay ${forge ? 'on' : 'off (no GitHub App configured)'}`);
await Promise.all([
  runDrainLoop({ name: 'intake', next: () => startNextTriage(runs), ...loop }),
  runDrainLoop({
    name: 'triage results',
    next: () => applyNextTriageResult(runs, config.CONFIDENCE_THRESHOLD),
    ...loop,
  }),
  runDrainLoop({ name: 'planning', next: () => startNextImplementation(runs, { trustedAuthors }), ...loop }),
  runDrainLoop({ name: 'implementation results', next: () => applyNextImplementation(runs), ...loop }),
  runDrainLoop({ name: 'gate results', next: () => applyNextGateResult(runs), ...loop }),
  forge
    ? runDrainLoop({
        name: 'outbox relay',
        next: () => deliverNextOutbox(new OutboxRelay(db), forge, () => control.allowsSending()),
        ...loop,
      })
    : Promise.resolve(),
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
