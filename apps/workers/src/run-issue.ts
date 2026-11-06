/**
 * Runs the whole factory on one GitHub issue, in one process, then stops:
 * intake, triage, the implement-and-gate loop, comments and the pull request.
 * This is how the factory is run by hand (the factory-run workflow) until it
 * has a permanent home. Spends API credit: triage on Haiku, implementation
 * with Claude Code, capped by the daily budget and the per-attempt budget.
 *
 *   node apps/workers/src/run-issue.ts --repo codyalves/factory-target-app --issue 1
 *
 * Env: DATABASE_URL, ANTHROPIC_API_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
 * and the worker's IMPLEMENT_* / TRIAGE_* settings.
 * Writes the report to stdout (and --report), the audit log to --audit.
 */
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { AuditStore, createDb, FactoryControl, migrate, OutboxRelay, RunStore, StepQueue } from '@factory/db';
import { ClaudeDecisionModel, loadPrompt } from '@factory/decisions';
import { DEFAULT_CONFIDENCE_THRESHOLD, isTerminal } from '@factory/domain';
import { GitHubAppAuth, GitHubForge, gitHubRepoAccess, parsePrivateKey } from '@factory/github';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  applyNextGateResult,
  applyNextImplementation,
  startNextImplementation,
} from '../../orchestrator/src/delivery.ts';
import { deliverNextOutbox } from '../../orchestrator/src/outbox.ts';
import { applyNextTriageResult, startNextTriage } from '../../orchestrator/src/triage.ts';
import { ClaudeCodeImplementer } from './claude-code-implementer.ts';
import { driveRun, renderRunReport } from './drive.ts';
import { loadTargets } from './gates.ts';
import { createHandlers } from './handlers.ts';
import { executeStep } from './step-runner.ts';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    issue: { type: 'string' },
    actor: { type: 'string', default: process.env.GITHUB_ACTOR ?? 'manual' },
    'daily-budget': { type: 'string', default: '3' },
    'max-rounds': { type: 'string', default: '60' },
    report: { type: 'string' },
    audit: { type: 'string' },
  },
});

const config = z
  .object({
    DATABASE_URL: z.url(),
    ANTHROPIC_API_KEY: z.string().min(1),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    TARGETS_FILE: z.string().default('gates/targets.json'),
    PROMPTS_DIR: z.string().default('prompts'),
    MIGRATIONS_DIR: z.string().default('db/migrations'),
    TRIAGE_MODEL: z.string().default('claude-haiku-5-5'),
    TRIAGE_PROMPT: z.string().default('triage.v3'),
    IMPLEMENT_MODEL: z.string().default('claude-sonnet-5-5'),
    IMPLEMENT_FRONTIER_MODEL: z.string().default('claude-opus-5-5'),
    IMPLEMENT_ESCALATE_AFTER: z.coerce.number().int().min(0).default(2),
    IMPLEMENT_ATTEMPT_BUDGET_USD: z.coerce.number().positive().max(20).default(1.25),
    IMPLEMENT_PROMPT: z.string().default('implement.v1'),
    CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(DEFAULT_CONFIDENCE_THRESHOLD),
  })
  .parse(process.env);

const repo = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .parse(args.repo);
const issueNumber = z.coerce.number().int().positive().parse(args.issue);
const actor = args.actor ?? 'manual';

const { db, pool, close } = createDb(config.DATABASE_URL);
await migrate(pool, config.MIGRATIONS_DIR);

const auth = new GitHubAppAuth({
  appId: config.GITHUB_APP_ID,
  privateKey: parsePrivateKey(config.GITHUB_APP_PRIVATE_KEY),
});
const forge = new GitHubForge({ auth });
const runs = new RunStore(db);
const queue = new StepQueue(db);
const control = new FactoryControl(db);
const relay = new OutboxRelay(db);

const issue = await forge.issue(repo, issueNumber);
const created = await runs.createFromIssue(issue, 'manual', `manual:${repo}#${issueNumber}:${Date.now()}`);
if (created.outcome !== 'created') {
  throw new Error(`could not start a run: ${created.outcome}`);
}
const runId = created.runId;
console.error(`run ${runId} for ${repo}#${issueNumber}: ${issue.title}`);

await control.setBudget(actor, Number(args['daily-budget']));
await control.resume(actor);

const handlers = createHandlers({
  runs,
  decisionModel: new ClaudeDecisionModel({
    client: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 }),
    model: config.TRIAGE_MODEL,
    prompt: await loadPrompt(config.PROMPTS_DIR, config.TRIAGE_PROMPT),
  }),
  delivery: {
    targets: await loadTargets(config.TARGETS_FILE),
    access: gitHubRepoAccess(auth),
    implementer: new ClaudeCodeImplementer({
      apiKey: config.ANTHROPIC_API_KEY,
      prompt: await loadPrompt(config.PROMPTS_DIR, config.IMPLEMENT_PROMPT),
      model: config.IMPLEMENT_MODEL,
      frontierModel: config.IMPLEMENT_FRONTIER_MODEL,
      escalateAfter: config.IMPLEMENT_ESCALATE_AFTER,
      maxBudgetUsd: config.IMPLEMENT_ATTEMPT_BUDGET_USD,
    }),
  },
});

const worker = `run-issue-${hostname()}`;
const stepOptions = {
  queue,
  worker,
  handlers,
  leaseMs: 45 * 60_000,
  idleDelayMs: 1_000,
  signal: new AbortController().signal,
  log: { info: console.error, warn: console.error, error: console.error },
};

const outcome = await driveRun({
  transitions: [
    () => startNextTriage(runs),
    () => applyNextTriageResult(runs, config.CONFIDENCE_THRESHOLD),
    () => startNextImplementation(runs),
    () => applyNextImplementation(runs),
    () => applyNextGateResult(runs),
    () => deliverNextOutbox(relay, forge, () => control.allowsSending()),
  ],
  async work() {
    const gate = await control.allowsWork();
    if (!gate.ok) {
      console.error(`not taking new work: ${gate.reason}`);
      return false;
    }
    const step = await queue.claim(worker, Object.keys(handlers), stepOptions.leaseMs);
    if (!step) return false;
    console.error(`running ${step.kind} step ${step.id}`);
    await executeStep(step, stepOptions);
    return true;
  },
  async finished() {
    const run = await runs.get(runId);
    if (!run) return true;
    const resting = isTerminal(run.state) || run.state === 'Reviewing';
    // Wait for comments and the pull request to go out before stopping.
    const { pending } = await db
      .selectFrom('outbox')
      .select((eb) => eb.fn.countAll<string>().as('pending'))
      .where('sent_at', 'is', null)
      .where('failed_at', 'is', null)
      .executeTakeFirstOrThrow();
    return resting && Number(pending) === 0;
  },
  maxRounds: Number(args['max-rounds']),
  log: console.error,
});

await control.pause(actor, 'manual run finished');

const audit = new AuditStore(db);
const events = await audit.readAll();
const { rows } = await sql<{
  spent: string;
}>`select coalesce(sum(usd), 0)::text as spent from cost_ledger`.execute(db);
const pr = await db
  .selectFrom('outbox')
  .select('result')
  .where('kind', '=', 'pull_request.open')
  .where('sent_at', 'is not', null)
  .executeTakeFirst();
const report = renderRunReport(
  events.filter((e) => e.runId === runId || e.runId === null),
  {
    title: `${repo}#${issueNumber} ${issue.title}`,
    spentUsd: Number(rows[0]?.spent ?? 0),
    pullRequestUrl: (pr?.result as { url?: string } | null)?.url ?? null,
    chainValid: (await audit.verifyInDatabase()).length === 0,
  },
);
console.log(
  outcome.finished ? report : `${report}\n\n**Stopped after ${outcome.rounds} rounds without finishing.**`,
);
if (args.report) await writeFile(args.report, report);
if (args.audit) await writeFile(args.audit, `${JSON.stringify(events, null, 2)}\n`);
await close();
