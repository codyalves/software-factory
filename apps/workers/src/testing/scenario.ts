/**
 * Realistic runs without the network: a local git "remote" with a tiny Node
 * project, a decision model that gives scripted answers, and an implementer
 * that follows a script per attempt. Everything else is the real factory:
 * intake, triage rules, the implement-and-gate loop, the outbox and the audit
 * chain. Used by integration tests and the dashboard's demo seed.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '@factory/db';
import { FactoryControl, OutboxRelay, RunStore, StepQueue } from '@factory/db';
import { questionVersion } from '@factory/decisions';
import type { Decision, DecisionModel, DecisionQuestion, ForgeAdapter, ForgeIssue } from '@factory/domain';
import { isTerminal } from '@factory/domain';
import type { Kysely } from 'kysely';
import {
  applyNextGateResult,
  applyNextImplementation,
  startNextImplementation,
} from '../../../orchestrator/src/delivery.ts';
import { deliverNextOutbox } from '../../../orchestrator/src/outbox.ts';
import { applyNextTriageResult, startNextTriage } from '../../../orchestrator/src/triage.ts';
import { driveRun } from '../drive.ts';
import type { TargetConfig } from '../gates.ts';
import { createHandlers } from '../handlers.ts';
import type { Implementer, ImplementInput } from '../implementer.ts';
import { executeStep } from '../step-runner.ts';
import { localRepoAccess } from '../workspace.ts';

export const SCENARIO_TARGET: TargetConfig = {
  baseBranch: 'main',
  setup: [],
  gates: { unit_tests: ['node', '--test'] },
  protectedPaths: ['.github/**', 'package.json'],
  riskPaths: { high: ['migrations/**'], medium: ['year.js'] },
  commandTimeoutMs: 60_000,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

/** A bare "remote" holding a tiny Node project whose footer year is hard-coded. */
export async function createTargetRepo(root: string): Promise<string> {
  const bare = join(root, 'target.git');
  const seed = join(root, 'seed');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
  git(root, 'init', '--quiet', '--initial-branch=main', seed);
  await writeFile(join(seed, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(seed, 'year.js'), 'export const footerYear = () => 2025;\n');
  await writeFile(
    join(seed, 'smoke.test.js'),
    "import { test } from 'node:test';\ntest('the module loads', async () => { await import('./year.js'); });\n",
  );
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '--quiet', 'origin', 'main');
  return bare;
}

export type Script = (input: ImplementInput) => Promise<void>;

/** An implementer that follows a script per attempt (the last script repeats) and meters a fixed cost. */
export function scripted(
  scripts: readonly Script[],
  costUsd = 0.25,
  model = 'claude-sonnet-5-5',
): Implementer & { inputs: ImplementInput[] } {
  const inputs: ImplementInput[] = [];
  return {
    name: `scripted/${model}`,
    inputs,
    async implement(input, { recordUsage }) {
      inputs.push(input);
      recordUsage({ model, inputTokens: 40_000, outputTokens: 3_000, usd: costUsd });
      await (scripts[input.attempt - 1] ?? scripts.at(-1))?.(input);
      return { summary: `attempt ${input.attempt}` };
    },
  };
}

export const fixYear: Script = async ({ dir }) => {
  await writeFile(join(dir, 'year.js'), 'export const footerYear = () => new Date().getFullYear();\n');
};

export const addTracedTest: Script = async (input) => {
  await fixYear(input);
  await writeFile(
    join(input.dir, 'year.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { footerYear } from './year.js';",
      ...input.criteria.map(
        (c) =>
          `test('${c.id}: ${c.text.replace(/'/g, '')}', () => {\n  assert.equal(footerYear(), new Date().getFullYear());\n});`,
      ),
      '',
    ].join('\n'),
  );
};

export const addMigration: Script = async (input) => {
  await addTracedTest(input);
  await mkdir(join(input.dir, 'migrations'), { recursive: true });
  await writeFile(join(input.dir, 'migrations', '001_year.sql'), 'alter table site add column year int;\n');
};

export type Answers = Readonly<Record<string, readonly [string, number]>>;

/** A clear, well-specified, low-risk feature, unless overridden. */
export const CLEAR_ANSWERS: Answers = {
  issue_type: ['feature', 0.94],
  spec_ready: ['yes', 0.91],
  risk_auth: ['no', 0.97],
  risk_data: ['no', 0.95],
  risk_payments: ['no', 0.98],
  risk_platform: ['no', 0.93],
  risk_existing_behavior: ['no', 0.88],
};

/** A decision model that answers from a script, billed like Haiku. */
export function scriptedDecisions(answers: Answers): DecisionModel {
  return {
    engine: 'scripted',
    decide<Option extends string>(
      question: DecisionQuestion<Option>,
      _material: string,
      context?: {
        onUsage?: (u: { model: string; inputTokens: number; outputTokens: number; usd: number }) => void;
      },
    ): Promise<Decision<Option>> {
      const [choice, probability] = answers[question.name] ?? [question.options[0], 0.9];
      context?.onUsage?.({ model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 30, usd: 0.000105 });
      return Promise.resolve({
        question: question.name,
        choice: choice as Option,
        probability,
        engine: 'claude',
        engineVersion: 'claude-haiku-5-5',
        promptVersion: 'triage.v3@scenario00000',
        questionVersion: questionVersion(question),
      });
    },
  };
}

/** Records what the factory would have sent to GitHub. */
export function recordingForge(): ForgeAdapter & { sent: { kind: string; body: string }[] } {
  const sent: { kind: string; body: string }[] = [];
  let next = 2;
  return {
    name: 'recording',
    sent,
    async comment(c) {
      sent.push({ kind: 'comment', body: c.body });
      return {
        url: `https://github.com/${c.repo}/issues/${c.issueNumber}#issuecomment-${next++}`,
        reused: false,
      };
    },
    async openPullRequest(pr) {
      sent.push({ kind: 'pull_request', body: pr.body });
      return { number: next, url: `https://github.com/${pr.repo}/pull/${next++}`, reused: false };
    },
    async mergePullRequest() {},
  };
}

/** Runs one issue through the whole factory and returns its run id. */
export async function runScenario(input: {
  db: Kysely<Database>;
  remote: string;
  issue: ForgeIssue;
  answers: Answers;
  implementer: Implementer;
  forge?: ForgeAdapter;
}): Promise<string> {
  const { db, issue } = input;
  const runs = new RunStore(db);
  const queue = new StepQueue(db);
  const control = new FactoryControl(db);
  const relay = new OutboxRelay(db, { random: () => 0 });
  const forge = input.forge ?? recordingForge();
  await control.resume('scenario');

  const created = await runs.createFromIssue(
    issue,
    'scenario',
    `scenario:${issue.repo}#${issue.number}:${Math.random()}`,
  );
  if (created.outcome !== 'created') throw new Error(`could not start a run: ${created.outcome}`);
  const runId = created.runId;

  const handlers = createHandlers({
    runs,
    decisionModel: scriptedDecisions(input.answers),
    delivery: {
      targets: { [issue.repo]: SCENARIO_TARGET },
      access: localRepoAccess({ [issue.repo]: input.remote }),
      implementer: input.implementer,
    },
  });
  const options = {
    queue,
    worker: 'scenario-worker',
    handlers,
    leaseMs: 120_000,
    idleDelayMs: 10,
    signal: new AbortController().signal,
    log: { info() {}, warn() {}, error() {} },
  };

  const outcome = await driveRun({
    transitions: [
      () => startNextTriage(runs),
      () => applyNextTriageResult(runs, 0.8),
      () => startNextImplementation(runs),
      () => applyNextImplementation(runs),
      () => applyNextGateResult(runs),
      () => deliverNextOutbox(relay, forge),
    ],
    async work() {
      const step = await queue.claim(options.worker, Object.keys(handlers), options.leaseMs);
      if (!step) return false;
      await executeStep(step, options);
      return true;
    },
    async finished() {
      const run = await runs.get(runId);
      const unsent = await db
        .selectFrom('outbox')
        .select('id')
        .where('run_id', '=', runId)
        .where('sent_at', 'is', null)
        .where('failed_at', 'is', null)
        .execute();
      return !!run && (isTerminal(run.state) || run.state === 'Reviewing') && unsent.length === 0;
    },
    maxRounds: 60,
    log: () => {},
  });
  if (!outcome.finished) throw new Error(`run ${runId} did not finish`);
  return runId;
}
