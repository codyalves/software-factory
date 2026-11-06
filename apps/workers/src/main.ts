import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { createDb, FactoryControl, RunStore, StepQueue } from '@factory/db';
import { ClaudeDecisionModel, loadPrompt } from '@factory/decisions';
import { GitHubAppAuth, gitHubRepoAccess, parsePrivateKey } from '@factory/github';
import { z } from 'zod';
import { loadTargets } from './gates.ts';
import { createHandlers } from './handlers.ts';
import { runSteps } from './step-runner.ts';
import { localRepoAccess, type RepoAccess } from './workspace.ts';

const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

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
      .default('triage.v3'),
    // Implement and gate steps: where targets are configured and how to reach them.
    TARGETS_FILE: z.string().default('gates/targets.json'),
    // Local mode: a JSON map of "owner/repo" -> path to a git repo; replaces GitHub access.
    LOCAL_REPOS: optional,
    GITHUB_APP_ID: optional,
    GITHUB_APP_PRIVATE_KEY: optional,
    GITHUB_APP_PRIVATE_KEY_FILE: optional,
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

function repoAccess(): RepoAccess | null {
  if (config.LOCAL_REPOS) {
    return localRepoAccess(z.record(z.string(), z.string()).parse(JSON.parse(config.LOCAL_REPOS)));
  }
  const key =
    config.GITHUB_APP_PRIVATE_KEY ??
    (config.GITHUB_APP_PRIVATE_KEY_FILE
      ? readFileSync(config.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8')
      : undefined);
  return config.GITHUB_APP_ID && key
    ? gitHubRepoAccess(new GitHubAppAuth({ appId: config.GITHUB_APP_ID, privateKey: parsePrivateKey(key) }))
    : null;
}

const access = repoAccess();
const handlers = createHandlers({
  runs: new RunStore(db),
  decisionModel,
  // The implementer arrives with the Claude Code integration; until then this worker only gates.
  delivery: access ? { targets: await loadTargets(config.TARGETS_FILE), access, implementer: null } : null,
});

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
