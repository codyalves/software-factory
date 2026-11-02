import { hostname } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { createDb, FactoryControl, RunStore, StepQueue } from '@factory/db';
import { ClaudeDecisionModel, loadPrompt } from '@factory/decisions';
import { z } from 'zod';
import { createHandlers } from './handlers.ts';
import { runSteps } from './step-runner.ts';

const config = z
  .object({
    DATABASE_URL: z.url(),
    WORKER_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
    LEASE_MS: z.coerce.number().int().positive().default(60_000),
    IDLE_DELAY_MS: z.coerce.number().int().positive().default(2_000),
    // Without a key the worker runs but does not take triage steps.
    ANTHROPIC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    TRIAGE_MODEL: z.string().default('claude-haiku-5-5'),
    PROMPTS_DIR: z.string().default('prompts'),
    TRIAGE_PROMPT: z
      .string()
      .regex(/^[\w.-]+$/)
      .default('triage.v2'),
  })
  .parse(process.env);

const { db, close } = createDb(config.DATABASE_URL);
const controller = new AbortController();
const control = new FactoryControl(db);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

const decisionModel = config.ANTHROPIC_API_KEY
  ? new ClaudeDecisionModel({
      // The step queue owns retries (with backoff and an audit trail), so the SDK does not retry.
      client: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 }),
      model: config.TRIAGE_MODEL,
      prompt: await loadPrompt(config.PROMPTS_DIR, config.TRIAGE_PROMPT),
    })
  : null;

const handlers = createHandlers({ runs: new RunStore(db), decisionModel });

console.info(`worker ${config.WORKER_ID} started; handles: ${Object.keys(handlers).join(', ') || 'none'}`);
await runSteps({
  queue: new StepQueue(db),
  canClaim: () => control.allowsWork(),
  worker: config.WORKER_ID,
  handlers,
  leaseMs: config.LEASE_MS,
  idleDelayMs: config.IDLE_DELAY_MS,
  signal: controller.signal,
  log: console,
});
await close();
console.info(`worker ${config.WORKER_ID} stopped`);
