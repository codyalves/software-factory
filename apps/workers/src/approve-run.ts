/**
 * Ships one run that was held for the owner, on the owner's approval, then
 * stops: Reviewing -> Merging with the approver in the audit log, the merge
 * request through the outbox, and a watch until GitHub has merged it (or
 * could not). This is what the dashboard's Approve button runs, through the
 * factory-approve workflow. It calls no model and spends no API credit.
 *
 *   node apps/workers/src/approve-run.ts --run <run id> --actor <github login>
 *
 * Env: DATABASE_URL (the factory's own database: the run must be in it),
 * GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY.
 * Writes the report to stdout (and --report), the audit log to --audit.
 * Exits 1 unless the run ended Merged.
 */
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  AuditStore,
  createDb,
  FactoryControl,
  migrate,
  OutboxRelay,
  ReportStore,
  RunStore,
  StepQueue,
} from '@factory/db';
import { isTerminal } from '@factory/domain';
import { GitHubAppAuth, GitHubForge, parsePrivateKey } from '@factory/github';
import { z } from 'zod';
import { applyNextMergeResult, approveHeldRun } from '../../orchestrator/src/delivery.ts';
import { deliverNextOutbox } from '../../orchestrator/src/outbox.ts';
import { driveRun, renderRunReport } from './drive.ts';
import { createMergeHandler, MERGE_STEP } from './handlers/merge.ts';
import { executeStep } from './step-runner.ts';

const { values: args } = parseArgs({
  options: {
    run: { type: 'string' },
    actor: { type: 'string' },
    /** How long to keep trying while GitHub has not merged yet (checks still running). */
    'wait-minutes': { type: 'string', default: '45' },
    report: { type: 'string' },
    audit: { type: 'string' },
  },
});

const config = z
  .object({
    DATABASE_URL: z.url(),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    MIGRATIONS_DIR: z.string().default('db/migrations'),
  })
  .parse(process.env);

const runId = z.uuid().parse(args.run);
// An approval is a person's decision, so it is refused without a name to record.
const actor = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,39}$/, 'the approver must be a GitHub login')
  .parse(args.actor);
const waitMs = z.coerce.number().positive().max(300).parse(args['wait-minutes']) * 60_000;

const { db, pool, close } = createDb(config.DATABASE_URL);
await migrate(pool, config.MIGRATIONS_DIR);

const forge = new GitHubForge({
  auth: new GitHubAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: parsePrivateKey(config.GITHUB_APP_PRIVATE_KEY),
  }),
});
const runs = new RunStore(db);
const queue = new StepQueue(db);
const control = new FactoryControl(db);
const relay = new OutboxRelay(db);

const before = await runs.get(runId);
if (!before) {
  await close();
  throw new Error(`run ${runId} is not in this database`);
}

// A paused factory sends nothing. The owner asked for this merge, so the
// pause is lifted for it and put back, with its reason, when it is done.
const paused = await control.status();
if (paused.paused) await control.resume(actor);

const approved = await approveHeldRun(runs, runId, actor);
console.error(approved ?? `run ${runId} is ${before.state}, not held for review: nothing to approve`);

const handlers = { [MERGE_STEP]: createMergeHandler({ forge }) };
const worker = `approve-run-${hostname()}`;
const leaseMs = 30 * 60_000;

const pendingOutbox = async () => {
  const { pending } = await db
    .selectFrom('outbox')
    .select((eb) => eb.fn.countAll<string>().as('pending'))
    .where('run_id', '=', runId)
    .where('sent_at', 'is', null)
    .where('failed_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(pending);
};
const finished = async () => {
  const run = await runs.get(runId);
  return !run || (isTerminal(run.state) && (await pendingOutbox()) === 0);
};

if (approved) {
  // A merge request or a watch that is not ready yet (checks still running)
  // is retried later by the outbox and the queue, so keep coming back to it.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const outcome = await driveRun({
      transitions: [
        () => applyNextMergeResult(runs),
        () => deliverNextOutbox(relay, forge, () => control.allowsSending()),
      ],
      async work() {
        const step = await queue.claim(worker, [MERGE_STEP], leaseMs);
        if (!step) return false;
        console.error(`running ${step.kind} step ${step.id}`);
        await executeStep(step, {
          queue,
          worker,
          handlers,
          leaseMs,
          idleDelayMs: 1_000,
          signal: new AbortController().signal,
          log: { info: console.error, warn: console.error, error: console.error },
        });
        return true;
      },
      finished,
      maxRounds: 20,
      log: console.error,
    });
    if (outcome.finished || Date.now() > deadline) break;
    await sleep(30_000);
  }
}

if (paused.paused) await control.pause(actor, paused.reason ?? 'paused before an approval');

const after = await runs.get(runId);
const audit = new AuditStore(db);
const events = await audit.readRun(runId);
const summary = await new ReportStore(db).runReport(runId);
const report = renderRunReport(events, {
  title: summary ? `${summary.repo}#${summary.issueNumber} ${summary.title}` : runId,
  spentUsd: summary?.spentUsd ?? 0,
  pullRequestUrl: summary?.pullRequestUrl ?? null,
  chainValid: (await audit.verifyInDatabase()).length === 0,
});
console.log(report);
if (args.report) await writeFile(args.report, report);
if (args.audit) await writeFile(args.audit, `${JSON.stringify(events, null, 2)}\n`);
await close();

if (after?.state !== 'Merged') {
  console.error(`run ${runId} ended ${after?.state ?? 'missing'}, not Merged`);
  process.exitCode = 1;
}
