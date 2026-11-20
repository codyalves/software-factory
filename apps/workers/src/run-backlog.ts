/**
 * Works through a target's backlog: takes the oldest open issue labeled
 * factory:ready whose dependencies are closed, runs it exactly like a manual
 * run (run-issue.ts, in its own process), and moves on once it has shipped,
 * been held or escalated. Stops when nothing is ready, after --max-runs, or
 * when a run cannot finish (the daily budget or a pause).
 *
 * After each shipped run it checks production: it waits for the host's
 * deploy of the merge commit, then runs the tester against the live site.
 * A new confirmed problem reverts the change, through the outbox, and stops
 * the session; so does a deploy that fails or never finishes.
 *
 *   node apps/workers/src/run-backlog.ts --repo codyalves/factory-target-app
 *
 * Same environment as run-issue.ts. Writes a summary to stdout and --summary,
 * and each run's report and audit log to --out.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  AuditStore,
  appendAuditEvent,
  createDb,
  enqueueOutbox,
  FactoryControl,
  migrate,
  OutboxRelay,
} from '@factory/db';
import {
  type DeployState,
  nextFromBacklog,
  type PostDeployDecision,
  postDeployDecision,
  READY_LABEL,
} from '@factory/domain';
import { GitHubAppAuth, GitHubForge, parsePrivateKey } from '@factory/github';
import { z } from 'zod';
import { deliverNextOutbox } from '../../orchestrator/src/outbox.ts';
import { loadTargets } from './gates.ts';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    label: { type: 'string', default: READY_LABEL },
    'max-runs': { type: 'string', default: '10' },
    actor: { type: 'string', default: process.env.GITHUB_ACTOR ?? 'manual' },
    'daily-budget': { type: 'string', default: '3' },
    out: { type: 'string', default: 'backlog' },
    summary: { type: 'string' },
    /** A checkout of the target with its dependencies installed, for the tester's repro tests. */
    'target-dir': { type: 'string', default: 'target' },
    'deploy-wait-minutes': { type: 'string', default: '15' },
  },
});

const config = z
  .object({
    DATABASE_URL: z.url(),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    MIGRATIONS_DIR: z.string().default('db/migrations'),
    TARGETS_FILE: z.string().default('gates/targets.json'),
  })
  .parse(process.env);

const repo = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .parse(args.repo);
const maxRuns = z.coerce.number().int().min(1).max(50).parse(args['max-runs']);
const label = args.label ?? READY_LABEL;
const out = args.out ?? 'backlog';
await mkdir(out, { recursive: true });

const { db, pool, close } = createDb(config.DATABASE_URL);
await migrate(pool, config.MIGRATIONS_DIR);
const production = (await loadTargets(config.TARGETS_FILE))[repo]?.production ?? null;
const deployWaitMs = z.coerce.number().int().min(1).max(60).parse(args['deploy-wait-minutes']) * 60_000;
const forge = new GitHubForge({
  auth: new GitHubAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: parsePrivateKey(config.GITHUB_APP_PRIVATE_KEY),
  }),
});

/** States a run rests in once the factory is done with it. */
const SETTLED = new Set(['Merged', 'Reviewing', 'Escalated', 'Rejected', 'Cancelled']);

async function latestRun(issueNumber: number) {
  return db
    .selectFrom('run')
    .innerJoin('requirement', 'requirement.id', 'run.requirement_id')
    .select(['run.id', 'run.state', 'run.branch'])
    .where('requirement.repo', '=', repo)
    .where('requirement.issue_number', '=', issueNumber)
    .orderBy('run.created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
}

function spawnNode(script: string, scriptArgs: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // Reports go to their files; progress stays on stderr.
    const child = spawn(process.execPath, [script, ...scriptArgs], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Production after a shipped run: wait for the deploy of its merge commit,
 * crawl the live site, and revert the change if the tester confirms anything
 * new. Every outcome is in the run's audit log.
 */
async function checkProduction(
  issue: { number: number; title: string },
  run: { id: string; branch: string | null },
): Promise<PostDeployDecision> {
  if (!production) {
    return { action: 'continue', reason: 'no production URL in gates/targets.json, so not checked' };
  }
  const merged = (await new AuditStore(db).readRun(run.id)).find((e) => e.type === 'delivery.merged');
  const mergeSha = merged ? (JSON.parse(merged.payload) as { mergeSha?: string }).mergeSha : undefined;
  if (!mergeSha || !run.branch) return { action: 'stop', reason: 'the run has no merge commit on record' };

  let deploy: DeployState = 'none';
  for (const deadline = Date.now() + deployWaitMs; Date.now() < deadline; await sleep(20_000)) {
    deploy = (await forge.deploymentState(repo, mergeSha, production.environment)).state;
    if (deploy === 'success' || deploy === 'failure') break;
  }

  let filed: string[] = [];
  if (deploy === 'success') {
    const started = new Date();
    console.error(`backlog: #${issue.number} is live; checking ${production.url}`);
    const code = await spawnNode('apps/tester/src/run-tester.ts', [
      '--repo',
      repo,
      '--base-url',
      production.url,
      '--workdir',
      args['target-dir'] ?? 'target',
      '--file',
      '--actor',
      args.actor ?? 'manual',
      '--report',
      join(out, `production-${issue.number}.md`),
    ]);
    if (code !== 0) return { action: 'stop', reason: `the production check crashed (exit ${code})` };
    const rows = await db
      .selectFrom('outbox')
      .select('result')
      .where('kind', '=', 'issue.create')
      .where('created_at', '>=', started)
      .where('sent_at', 'is not', null)
      .execute();
    filed = rows.map((r) => (r.result as { url?: string } | null)?.url ?? 'issue');
  }

  const decision = postDeployDecision(deploy, filed.length);
  await db.transaction().execute(async (trx) => {
    await appendAuditEvent(
      trx,
      run.id,
      decision.action === 'continue' ? 'delivery.verified' : 'delivery.check_failed',
      {
        url: production.url,
        mergeSha,
        deploy,
        findings: filed,
        action: decision.action,
        reason: decision.reason,
      },
    );
    if (decision.action === 'revert') {
      await enqueueOutbox(trx, run.id, 'pull_request.revert', {
        repo,
        head: run.branch,
        title: `Revert #${issue.number}: ${issue.title}`.slice(0, 250),
        body: [
          `The factory shipped #${issue.number} and then checked production: ${decision.reason}.`,
          '',
          ...filed.map((url) => `- ${url}`),
          '',
          'This reverts the change. It merges once the required checks pass, like any factory change. The findings stay open as issues with their regression tests.',
        ].join('\n'),
      });
    }
  });
  if (decision.action === 'revert') {
    const control = new FactoryControl(db);
    await control.resume(args.actor ?? 'manual');
    const relay = new OutboxRelay(db);
    for (
      let sent = await deliverNextOutbox(relay, forge);
      sent;
      sent = await deliverNextOutbox(relay, forge)
    ) {
      console.error(sent);
    }
    await control.pause(args.actor ?? 'manual', 'backlog reverted a change');
  }
  return decision;
}

function runIssue(issueNumber: number): Promise<number> {
  return spawnNode('apps/workers/src/run-issue.ts', [
    '--repo',
    repo,
    '--issue',
    String(issueNumber),
    '--daily-budget',
    args['daily-budget'] ?? '3',
    '--actor',
    args.actor ?? 'manual',
    '--report',
    join(out, `report-${issueNumber}.md`),
    '--audit',
    join(out, `audit-${issueNumber}.json`),
  ]);
}

const tried = new Set<number>();
const lines = [`## Backlog run: ${repo} (label \`${label}\`)`, '', '| Issue | Result |', '| --- | --- |'];
let stopReason = `reached --max-runs (${maxRuns})`;

try {
  for (let i = 0; i < maxRuns; i++) {
    const issues = await forge.openIssues(repo);
    const choice = nextFromBacklog(issues, new Set(issues.map((x) => x.number)), tried, label);
    if (!choice.next) {
      const waiting = choice.blocked.map(
        (b) => `#${b.number} waits on ${b.on.map((n) => `#${n}`).join(', ')}`,
      );
      stopReason =
        waiting.length > 0 ? `nothing else is ready (${waiting.join('; ')})` : 'the backlog is empty';
      break;
    }

    const issue = choice.next;
    tried.add(issue.number);
    console.error(`backlog: running #${issue.number} ${issue.title}`);
    const code = await runIssue(issue.number);
    const run = await latestRun(issue.number);
    const state = run?.state ?? null;
    const title = issue.title.replace(/\|/g, '\\|');

    if (code !== 0) {
      lines.push(`| #${issue.number} ${title} | ${state ?? 'no run'} |`);
      stopReason = `the run for #${issue.number} failed to start or crashed (exit ${code})`;
      break;
    }
    if (!run || !state || !SETTLED.has(state)) {
      lines.push(`| #${issue.number} ${title} | ${state ?? 'no run'} |`);
      stopReason = `#${issue.number} could not finish (${state ?? 'no run'}): the daily budget or a pause stopped it`;
      break;
    }
    if (state !== 'Merged') {
      lines.push(`| #${issue.number} ${title} | ${state} |`);
      continue;
    }
    const check = await checkProduction(issue, run);
    lines.push(`| #${issue.number} ${title} | Merged; ${check.reason} |`);
    if (check.action !== 'continue') {
      stopReason =
        check.action === 'revert'
          ? `#${issue.number} was reverted because ${check.reason}`
          : `after #${issue.number}, ${check.reason}`;
      break;
    }
  }
} finally {
  await close();
}

lines.push('', `Stopped: ${stopReason}.`);
const read = (file: string) => readFile(join(out, file), 'utf8').catch(() => '');
const reports = (
  await Promise.all(
    [...tried].map(async (n) => [await read(`report-${n}.md`), await read(`production-${n}.md`)]),
  )
).flat();
const summary = [lines.join('\n'), ...reports.filter(Boolean)].join('\n\n---\n\n');
console.log(summary);
if (args.summary) await writeFile(args.summary, `${summary}\n`);
