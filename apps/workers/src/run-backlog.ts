/**
 * Works through a target's backlog: takes the oldest open issue labeled
 * factory:ready whose dependencies are closed, runs it exactly like a manual
 * run (run-issue.ts, in its own process), and moves on once it has shipped,
 * been held or escalated. Stops when nothing is ready, after --max-runs, or
 * when a run cannot finish (the daily budget or a pause).
 *
 *   node apps/workers/src/run-backlog.ts --repo codyalves/factory-target-app
 *
 * Same environment as run-issue.ts. Writes a summary to stdout and --summary,
 * and each run's report and audit log to --out.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb, migrate } from '@factory/db';
import { nextFromBacklog, READY_LABEL } from '@factory/domain';
import { GitHubAppAuth, GitHubForge, parsePrivateKey } from '@factory/github';
import { z } from 'zod';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    label: { type: 'string', default: READY_LABEL },
    'max-runs': { type: 'string', default: '10' },
    actor: { type: 'string', default: process.env.GITHUB_ACTOR ?? 'manual' },
    'daily-budget': { type: 'string', default: '3' },
    out: { type: 'string', default: 'backlog' },
    summary: { type: 'string' },
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
const forge = new GitHubForge({
  auth: new GitHubAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: parsePrivateKey(config.GITHUB_APP_PRIVATE_KEY),
  }),
});

/** States a run rests in once the factory is done with it. */
const SETTLED = new Set(['Merged', 'Reviewing', 'Escalated', 'Rejected', 'Cancelled']);

async function latestState(issueNumber: number): Promise<string | null> {
  const row = await db
    .selectFrom('run')
    .innerJoin('requirement', 'requirement.id', 'run.requirement_id')
    .select('run.state')
    .where('requirement.repo', '=', repo)
    .where('requirement.issue_number', '=', issueNumber)
    .orderBy('run.created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.state ?? null;
}

function runIssue(issueNumber: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'apps/workers/src/run-issue.ts',
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
      ],
      // The child's report goes to its file; its progress stays on stderr.
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
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
    const state = await latestState(issue.number);
    lines.push(`| #${issue.number} ${issue.title.replace(/\|/g, '\\|')} | ${state ?? 'no run'} |`);

    if (code !== 0) {
      stopReason = `the run for #${issue.number} failed to start or crashed (exit ${code})`;
      break;
    }
    if (!state || !SETTLED.has(state)) {
      stopReason = `#${issue.number} could not finish (${state ?? 'no run'}): the daily budget or a pause stopped it`;
      break;
    }
  }
} finally {
  await close();
}

lines.push('', `Stopped: ${stopReason}.`);
const reports = await Promise.all(
  [...tried].map((n) => readFile(join(out, `report-${n}.md`), 'utf8').catch(() => '')),
);
const summary = [lines.join('\n'), ...reports.filter(Boolean)].join('\n\n---\n\n');
console.log(summary);
if (args.summary) await writeFile(args.summary, `${summary}\n`);
