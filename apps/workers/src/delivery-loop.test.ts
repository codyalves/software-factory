import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditStore, OutboxRelay, RunStore, StepQueue } from '@factory/db';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '@factory/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyNextGateResult,
  applyNextImplementation,
  startNextImplementation,
} from '../../orchestrator/src/delivery.ts';
import { deliverNextOutbox } from '../../orchestrator/src/outbox.ts';
import { driveRun, renderRunReport } from './drive.ts';
import type { TargetConfig } from './gates.ts';
import { createHandlers } from './handlers.ts';
import type { Implementer, ImplementInput } from './implementer.ts';
import { executeStep } from './step-runner.ts';
import { localRepoAccess } from './workspace.ts';

const REPO = 'codyalves/target';
const silent = { info() {}, warn() {}, error() {} };

const target: TargetConfig = {
  baseBranch: 'main',
  setup: [],
  gates: { unit_tests: ['node', '--test'] },
  protectedPaths: ['.github/**', 'package.json'],
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

/** A bare "remote" holding a tiny Node project with a bug: the footer year is hard-coded. */
async function createTargetRepo(root: string): Promise<string> {
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

type Script = (input: ImplementInput) => Promise<void>;

/** An implementer that follows a script per attempt and records what it was told. */
function scripted(scripts: readonly Script[]): Implementer & { inputs: ImplementInput[] } {
  const inputs: ImplementInput[] = [];
  return {
    name: 'scripted/test',
    inputs,
    async implement(input, { recordUsage }) {
      inputs.push(input);
      recordUsage({ model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 200, usd: 0.25 });
      await (scripts[input.attempt - 1] ?? scripts.at(-1))?.(input);
      return { summary: `attempt ${input.attempt}` };
    },
  };
}

const fixYear: Script = async ({ dir }) => {
  await writeFile(join(dir, 'year.js'), 'export const footerYear = () => new Date().getFullYear();\n');
};

const addTracedTest: Script = async ({ dir }) => {
  await fixYear({ dir } as ImplementInput);
  await writeFile(
    join(dir, 'year.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { footerYear } from './year.js';",
      "test('AC-1: the footer shows the current year', () => {",
      '  assert.equal(footerYear(), new Date().getFullYear());',
      '});',
      '',
    ].join('\n'),
  );
};

describe.skipIf(!TEST_DATABASE_URL)('implement-and-gate loop', () => {
  let root: string;
  let bare: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-test-'));
    bare = await createTargetRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function setup(
    t: TestDatabase,
    implementer: Implementer,
    body = '- The footer shows the current year',
  ) {
    const runs = new RunStore(t.db);
    const queue = new StepQueue(t.db);
    const created = await runs.createFromIssue(
      { repo: REPO, number: 7, title: 'Footer shows last year', body, labels: ['factory'] },
      'github',
      'delivery-1',
    );
    if (created.outcome !== 'created') throw new Error('expected a run');
    // Triage is covered elsewhere; start this run as a triaged, planned issue.
    await runs.advanceNext('Intake', 'Triage', 'test');
    await runs.advanceNext('Triage', 'Planning', 'test');

    const handlers = createHandlers({
      runs,
      decisionModel: null,
      delivery: { targets: { [REPO]: target }, access: localRepoAccess({ [REPO]: bare }), implementer },
    });
    const work = async () => {
      const step = await queue.claim('worker-1', Object.keys(handlers), 120_000);
      if (!step) throw new Error('no step queued');
      await executeStep(step, {
        queue,
        worker: 'worker-1',
        handlers,
        leaseMs: 120_000,
        idleDelayMs: 10,
        signal: new AbortController().signal,
        log: silent,
      });
    };
    /** One implement attempt and its gates, through orchestrator and worker. */
    const attempt = async () => {
      await work();
      expect(await applyNextImplementation(runs)).toMatch(/moved to Gating/);
      await work();
      return applyNextGateResult(runs);
    };
    return { runs, queue, handlers, runId: created.runId, attempt };
  }

  it('iterates on failed gates until they pass, then opens a traced pull request', async () => {
    await using t = await createTestDatabase();
    const implementer = scripted([fixYear, addTracedTest]);
    const { runs, runId, attempt } = await setup(t, implementer);

    expect(await startNextImplementation(runs)).toMatch(/moved to Implementing/);

    // Attempt 1 fixes the code but writes no test for AC-1.
    expect(await attempt()).toMatch(/moved to Implementing/);
    expect(implementer.inputs[0]).toMatchObject({
      attempt: 1,
      feedback: null,
      criteria: [{ id: 'AC-1', text: 'The footer shows the current year' }],
    });

    // Attempt 2 is told why, continues the same branch, and passes.
    expect(await attempt()).toMatch(/moved to Reviewing/);
    expect(implementer.inputs[1]?.feedback).toContain('### Gate failed: traceability');
    expect(implementer.inputs[1]?.feedback).toContain('AC-1: The footer shows the current year');

    const run = await t.db.selectFrom('run').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      state: 'Reviewing',
      implement_attempts: 2,
      branch: `factory/7-${runId.slice(0, 8)}`,
    });

    // Both attempts are commits on the factory branch, tied to the run.
    const log = git(bare, 'log', '--format=%s%n%b', `factory/7-${runId.slice(0, 8)}`);
    expect(log).toContain('Attempt 1 at #7');
    expect(log).toContain('Attempt 2 at #7');
    expect(log).toContain(`Factory-Run: ${runId}`);
    expect(log).toContain('Factory-Implementer: scripted/test');
    expect(git(bare, 'rev-parse', `factory/7-${runId.slice(0, 8)}`).trim()).toBe(run.head_sha);

    // Every gate verdict for every attempt is on record.
    const gates = await t.db
      .selectFrom('gate_result')
      .select(['attempt', 'gate', 'passed'])
      .where('run_id', '=', runId)
      .orderBy('attempt')
      .orderBy('created_at')
      .execute();
    expect(gates).toEqual([
      { attempt: 1, gate: 'changes', passed: true },
      { attempt: 1, gate: 'protected_paths', passed: true },
      { attempt: 1, gate: 'secret_scan', passed: true },
      { attempt: 1, gate: 'unit_tests', passed: true },
      { attempt: 1, gate: 'traceability', passed: false },
      { attempt: 2, gate: 'changes', passed: true },
      { attempt: 2, gate: 'protected_paths', passed: true },
      { attempt: 2, gate: 'secret_scan', passed: true },
      { attempt: 2, gate: 'unit_tests', passed: true },
      { attempt: 2, gate: 'traceability', passed: true },
    ]);

    // Requirement -> criterion -> test -> commit.
    const trace = await t.db
      .selectFrom('trace_link')
      .select(['criterion_id', 'test_id', 'commit_sha'])
      .execute();
    expect(trace).toEqual([{ criterion_id: 'AC-1', test_id: 'year.test.js:4', commit_sha: run.head_sha }]);

    const outbox = await t.db.selectFrom('outbox').select(['kind', 'payload']).execute();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.kind).toBe('pull_request.open');
    expect(outbox[0]?.payload).toMatchObject({ repo: REPO, head: run.branch, base: 'main' });
    const body = (outbox[0]?.payload as { body: string } | undefined)?.body ?? '';
    expect(body).toContain('Closes #7.');
    expect(body).toContain('| AC-1 | The footer shows the current year | `year.test.js:4` |');
    expect(body).toContain('| traceability | passed');

    // Both implement attempts were metered against the run.
    const spend = await t.db.selectFrom('cost_ledger').select('usd').where('run_id', '=', runId).execute();
    expect(spend).toHaveLength(2);

    const audit = await new AuditStore(t.db);
    const types = (await audit.readAll()).map((e) => e.type);
    expect(types.filter((x) => x === 'gating.completed')).toHaveLength(2);
    expect(types).toContain('traceability.recorded');
    expect(await audit.verifyInDatabase()).toEqual([]);
  });

  it('escalates with a comment once the attempts are spent', async () => {
    await using t = await createTestDatabase();
    const { runs, runId, attempt } = await setup(t, scripted([fixYear]));
    await startNextImplementation(runs);

    for (let i = 1; i < 4; i++) expect(await attempt()).toMatch(/moved to Implementing/);
    expect(await attempt()).toMatch(/moved to Escalated/);

    const run = await t.db.selectFrom('run').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.implement_attempts).toBe(4);
    const comment = await t.db.selectFrom('outbox').select(['kind', 'payload']).executeTakeFirstOrThrow();
    expect(comment.kind).toBe('issue.comment');
    expect((comment.payload as { body: string }).body).toContain('made 4 attempts');
  });

  it('fails an attempt that edits a protected file or adds a credential', async () => {
    await using t = await createTestDatabase();
    const sneaky: Script = async (input) => {
      await addTracedTest(input);
      const pkg = join(input.dir, 'package.json');
      await writeFile(pkg, (await readFile(pkg, 'utf8')).replace('}', ', "scripts": { "test": "true" } }'));
      await writeFile(join(input.dir, 'config.js'), `export const key = "sk-ant-${'x'.repeat(30)}";\n`);
    };
    const { runs, runId, attempt } = await setup(t, scripted([sneaky, addTracedTest]));
    await startNextImplementation(runs);

    expect(await attempt()).toMatch(/moved to Implementing/);

    const failed = await t.db
      .selectFrom('gate_result')
      .select(['gate', 'details'])
      .where('run_id', '=', runId)
      .where('passed', '=', false)
      .execute();
    expect(failed.map((g) => g.gate)).toEqual(['protected_paths', 'secret_scan']);
    expect(failed[1]?.details).toContain('config.js:1: looks like a Anthropic API key');
    expect(failed[1]?.details).not.toContain('xxxxxxxx');
  });

  it('treats an attempt that changes nothing as a failed gate, not a crash', async () => {
    await using t = await createTestDatabase();
    const { runs, attempt } = await setup(t, scripted([async () => {}, addTracedTest]));
    await startNextImplementation(runs);

    expect(await attempt()).toMatch(/moved to Implementing/);
    expect(await attempt()).toMatch(/moved to Reviewing/);
  });

  it('escalates an issue with no acceptance criteria without starting work', async () => {
    await using t = await createTestDatabase();
    const { runs } = await setup(t, scripted([fixYear]), 'Please make the footer better.');

    expect(await startNextImplementation(runs)).toMatch(/moved to Escalated/);
    expect(await t.db.selectFrom('step').select('kind').where('kind', '=', 'implement').execute()).toEqual(
      [],
    );
  });

  it('drives a run to an opened pull request in one process, and reports it from the audit log', async () => {
    await using t = await createTestDatabase();
    const { runs, queue, handlers, runId } = await setup(t, scripted([fixYear, addTracedTest]));
    const opened: { head: string }[] = [];
    const forge = {
      name: 'fake',
      comment: async () => ({ url: 'comment', reused: false }),
      openPullRequest: async (pr: { head: string }) => {
        opened.push(pr);
        return { number: 12, url: 'https://github.com/codyalves/target/pull/12', reused: false };
      },
      mergePullRequest: async () => {},
    };
    const relay = new OutboxRelay(t.db);
    const lines: string[] = [];

    const outcome = await driveRun({
      transitions: [
        () => startNextImplementation(runs),
        () => applyNextImplementation(runs),
        () => applyNextGateResult(runs),
        () => deliverNextOutbox(relay, forge),
      ],
      async work() {
        const step = await queue.claim('worker-1', Object.keys(handlers), 120_000);
        if (!step) return false;
        await executeStep(step, {
          queue,
          worker: 'worker-1',
          handlers,
          leaseMs: 120_000,
          idleDelayMs: 10,
          signal: new AbortController().signal,
          log: silent,
        });
        return true;
      },
      async finished() {
        const run = await runs.get(runId);
        const unsent = await t.db.selectFrom('outbox').select('id').where('sent_at', 'is', null).execute();
        return run?.state === 'Reviewing' && unsent.length === 0;
      },
      maxRounds: 20,
      log: (line) => lines.push(line),
    });

    expect(outcome.finished).toBe(true);
    expect(opened).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/pull_request.open\) sent$/);

    const audit = new AuditStore(t.db);
    const report = renderRunReport(await audit.readAll(), {
      title: 'codyalves/target#7 Footer shows last year',
      spentUsd: 0.5,
      pullRequestUrl: 'https://github.com/codyalves/target/pull/12',
      chainValid: (await audit.verifyInDatabase()).length === 0,
    });
    expect(report).toContain('**Final state: Reviewing**: all 5 gates passed');
    expect(report).toContain('- Implement attempts: 2');
    expect(report).toContain('- **FAIL** traceability: 1 of 1 criteria have no test');
    expect(report).toContain('| AC-1 | `year.test.js:4` |');
    expect(report).toContain('Audit chain: valid');
  });

  it('stops driving when nothing can move', async () => {
    const outcome = await driveRun({
      transitions: [async () => null],
      work: async () => false,
      finished: async () => false,
      maxRounds: 5,
      log: () => {},
    });

    expect(outcome).toEqual({ rounds: 1, finished: false });
  });
});
