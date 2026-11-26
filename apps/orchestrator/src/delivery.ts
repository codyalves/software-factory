import {
  appendAuditEvent,
  type Database,
  enqueueOutbox,
  enqueueStep,
  type RunIssue,
  type RunStore,
} from '@factory/db';
import {
  type AcceptanceCriterion,
  type DeliveryDecision,
  deliveryDecision,
  extractCriteria,
  type GateResult,
  gatingOutcome,
  higherTier,
  parseRepro,
  RISK_TIERS,
  type RiskTier,
  type RunState,
  type TraceLink,
} from '@factory/domain';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';

export const IMPLEMENT_STEP = 'implement';
export const GATE_STEP = 'gate';
export const MERGE_STEP = 'merge';

/** Implementation runs a coding agent and gates run test suites: give them room. */
const IMPLEMENT_TIMEOUT_MS = 30 * 60_000;
const GATE_TIMEOUT_MS = 30 * 60_000;
/** One watch of a merge: the worker gives up after 20 minutes, and the queue retries twice. */
const MERGE_TIMEOUT_MS = 25 * 60_000;
const MERGE_ATTEMPTS = 3;

type Runs = Pick<RunStore, 'advanceNextWith' | 'advanceOnFinishedStep' | 'getIssue'>;

async function issueOf(runs: Pick<RunStore, 'getIssue'>, runId: string): Promise<RunIssue> {
  const issue = await runs.getIssue(runId);
  if (!issue) throw new Error(`run ${runId} has no issue`);
  return issue;
}

function enqueueImplement(
  trx: Transaction<Database>,
  runId: string,
  attempt: number,
  feedback: string | null,
) {
  return enqueueStep(trx, {
    runId,
    kind: IMPLEMENT_STEP,
    idempotencyKey: `${runId}:implement:${attempt}`,
    payload: { attempt, feedback },
    timeoutMs: IMPLEMENT_TIMEOUT_MS,
    maxAttempts: 2,
  });
}

/**
 * Planning -> Implementing. Numbers the issue's acceptance criteria (so tests,
 * commits and the audit log can name them) and queues the first attempt. An
 * issue with no criteria goes to a person: there is nothing to verify against.
 */
export async function startNextImplementation(
  runs: Runs,
  options: {
    /**
     * Logins whose issues may carry a regression test the implementer cannot
     * change: the factory's own App. Anyone else's embedded test is ignored.
     */
    readonly trustedAuthors?: readonly string[];
  } = {},
): Promise<string | null> {
  const run = await runs.advanceNextWith('Planning', async (trx, run) => {
    const issue = await issueOf(runs, run.id);
    const criteria = extractCriteria(issue.body);
    const repro = parseRepro(issue.body);
    if (repro) {
      const trusted = issue.author !== null && (options.trustedAuthors ?? []).includes(issue.author);
      if (trusted) {
        await trx
          .updateTable('requirement')
          .set({ regression: JSON.stringify(repro) })
          .where('id', '=', issue.requirementId)
          .execute();
        await appendAuditEvent(trx, run.id, 'plan.regression_test', {
          path: repro.path,
          author: issue.author,
        });
      } else {
        await appendAuditEvent(trx, run.id, 'plan.regression_test_ignored', {
          path: repro.path,
          author: issue.author,
          reason: 'only the factory may attach a protected regression test',
        });
      }
    }
    if (criteria.length === 0) {
      await enqueueOutbox(trx, run.id, 'issue.comment', {
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        body: 'The software factory needs acceptance criteria to work from: list each one as a bullet point, then reopen or relabel the issue.',
      });
      return { to: 'Escalated', reason: 'the issue lists no acceptance criteria' };
    }
    await trx
      .updateTable('requirement')
      .set({ criteria: JSON.stringify(criteria) })
      .where('id', '=', issue.requirementId)
      .execute();
    await appendAuditEvent(trx, run.id, 'plan.criteria', { criteria });
    await enqueueImplement(trx, run.id, run.implementAttempts + 1, null);
    return { to: 'Implementing', reason: `${criteria.length} acceptance criteria; attempt 1 queued` };
  });
  return run ? `run ${run.id} moved to ${run.state}` : null;
}

const implementResult = z.object({
  attempt: z.number().int().positive(),
  branch: z.string(),
  baseBranch: z.string(),
  baseSha: z.string(),
  commitSha: z.string(),
  committed: z.boolean(),
  continued: z.boolean(),
  implementer: z.string(),
  summary: z.string(),
});

/** Implementing -> Gating once the attempt is pushed; a failed attempt step escalates. */
export async function applyNextImplementation(runs: Runs): Promise<string | null> {
  const run = await runs.advanceOnFinishedStep('Implementing', IMPLEMENT_STEP, async (trx, run, step) => {
    if (step.status === 'dead_lettered') {
      await appendAuditEvent(trx, run.id, 'implementation.failed', {
        stepId: step.id,
        error: step.lastError,
      });
      const issue = await issueOf(runs, run.id);
      await enqueueOutbox(trx, run.id, 'issue.comment', {
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        body: 'The software factory could not run its implementation step for this issue, so a person needs to take it. The error is in the run audit log.',
      });
      return {
        to: 'Escalated',
        reason: `implementation could not run: ${step.lastError ?? 'unknown error'}`,
      };
    }
    const result = implementResult.parse(step.result);
    await trx
      .updateTable('run')
      .set({
        branch: result.branch,
        head_sha: result.commitSha,
        base_sha: sql<string>`coalesce(base_sha, ${result.baseSha})`,
      })
      .where('id', '=', run.id)
      .execute();
    // Gates always compare against the base of the first attempt.
    const { base_sha } = await trx
      .selectFrom('run')
      .select('base_sha')
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, run.id, 'implementation.committed', { stepId: step.id, ...result });
    await enqueueStep(trx, {
      runId: run.id,
      kind: GATE_STEP,
      idempotencyKey: `${run.id}:gate:${result.attempt}`,
      payload: {
        attempt: result.attempt,
        branch: result.branch,
        baseBranch: result.baseBranch,
        baseSha: base_sha ?? result.baseSha,
        commitSha: result.commitSha,
      },
      timeoutMs: GATE_TIMEOUT_MS,
      maxAttempts: 2,
    });
    return {
      to: 'Gating',
      reason: result.committed
        ? `attempt ${result.attempt} committed ${result.commitSha.slice(0, 12)}`
        : `attempt ${result.attempt} changed nothing`,
    };
  });
  return run ? `run ${run.id} moved to ${run.state}` : null;
}

const gateResult = z.object({
  attempt: z.number().int().positive(),
  branch: z.string(),
  baseBranch: z.string(),
  commitSha: z.string(),
  gates: z.array(
    z.object({ gate: z.string(), passed: z.boolean(), summary: z.string(), details: z.string().optional() }),
  ),
  links: z.array(z.object({ criterionId: z.string(), testId: z.string() })),
  // Absent on gate results recorded before risk was measured.
  risk: z
    .object({ tier: z.enum(RISK_TIERS), reasons: z.array(z.string()) })
    .default({ tier: 'low', reasons: [] }),
});

/** Spend on this run so far, from the cost ledger. */
async function runSpend(db: Kysely<Database>, runId: string): Promise<{ spent: number; budget: number }> {
  const { rows } = await sql<{ spent: string; budget: string }>`
    select coalesce((select sum(usd) from cost_ledger where run_id = ${runId}::uuid), 0)::text as spent,
           budget_usd::text as budget
    from run where id = ${runId}::uuid
  `.execute(db);
  return { spent: Number(rows[0]?.spent ?? 0), budget: Number(rows[0]?.budget ?? 0) };
}

/**
 * Gating -> Reviewing, Implementing or Escalated, by the gate results alone.
 * Records every gate result; on success records the traceability links and
 * queues the pull request; on failure queues the next attempt with the
 * failures as feedback, unless the attempts or the run's budget are spent.
 */
export async function applyNextGateResult(runs: Runs): Promise<string | null> {
  const run = await runs.advanceOnFinishedStep('Gating', GATE_STEP, async (trx, run, step) => {
    const issue = await issueOf(runs, run.id);
    if (step.status === 'dead_lettered') {
      await appendAuditEvent(trx, run.id, 'gating.failed', { stepId: step.id, error: step.lastError });
      await enqueueOutbox(trx, run.id, 'issue.comment', {
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        body: 'The software factory could not run the quality gates for this issue, so a person needs to take it. The error is in the run audit log.',
      });
      return { to: 'Escalated', reason: `gates could not run: ${step.lastError ?? 'unknown error'}` };
    }

    const result = gateResult.parse(step.result);
    const gates: GateResult[] = result.gates.map(({ details, ...g }) =>
      details === undefined ? g : { ...g, details },
    );
    for (const gate of gates) {
      await trx
        .insertInto('gate_result')
        .values({
          step_id: step.id,
          run_id: run.id,
          attempt: result.attempt,
          gate: gate.gate,
          passed: gate.passed,
          summary: gate.summary,
          details: (gate.details ?? '').slice(-20_000),
          artifact_sha: null,
        })
        .execute();
    }
    // Risk is the higher of what triage predicted from the issue and what the
    // diff measurably touched. Measurement can only raise it.
    const { risk_level: predicted } = await trx
      .selectFrom('requirement')
      .select('risk_level')
      .where('id', '=', issue.requirementId)
      .executeTakeFirstOrThrow();
    const risk = {
      predicted,
      measured: result.risk.tier,
      final: predicted ? higherTier(predicted, result.risk.tier) : result.risk.tier,
      reasons: result.risk.reasons,
    };

    // The audit record names every gate and its verdict; full output stays in gate_result.
    await appendAuditEvent(trx, run.id, 'gating.completed', {
      stepId: step.id,
      attempt: result.attempt,
      commitSha: result.commitSha,
      gates: gates.map(({ gate, passed, summary }) => ({ gate, passed, summary })),
      risk,
    });

    let outcome = gatingOutcome(gates, run.implementAttempts);
    if (outcome.next === 'Implementing') {
      const { spent, budget } = await runSpend(trx, run.id);
      if (spent >= budget) {
        outcome = {
          next: 'Escalated',
          reason: `run budget spent ($${spent.toFixed(2)} of $${budget.toFixed(2)}); gates still failing`,
          comment: `The software factory spent this run's budget ($${budget.toFixed(2)}) without getting every quality gate to pass, so a person needs to take it.`,
        };
      }
    }

    let next: RunState = outcome.next;
    let reason = outcome.reason;
    switch (outcome.next) {
      case 'Reviewing': {
        if (risk.final !== predicted) {
          await trx
            .updateTable('requirement')
            .set({ risk_level: risk.final })
            .where('id', '=', issue.requirementId)
            .execute();
          await appendAuditEvent(trx, run.id, 'risk.raised', {
            from: predicted,
            to: risk.final,
            reasons: risk.reasons,
          });
        }
        await recordTrace(trx, issue.requirementId, result.links, result.commitSha);
        await appendAuditEvent(trx, run.id, 'traceability.recorded', {
          commitSha: result.commitSha,
          links: result.links,
        });
        // Low and medium risk ship without a person; high risk waits for the owner.
        const delivery = deliveryDecision(risk.final);
        await appendAuditEvent(trx, run.id, 'delivery.decided', {
          decision: delivery.next === 'Merging' ? 'merge' : 'hold',
          risk: risk.final,
          reason: delivery.reason,
        });
        await enqueueOutbox(trx, run.id, 'pull_request.open', {
          repo: issue.repo,
          head: result.branch,
          base: result.baseBranch,
          title: issue.title,
          body: pullRequestBody(issue, run.id, result.attempt, gates, result.links, risk, delivery),
        });
        if (delivery.next === 'Merging') {
          const target = { repo: issue.repo, head: result.branch };
          await enqueueOutbox(trx, run.id, 'pull_request.merge', target);
          await enqueueStep(trx, {
            runId: run.id,
            kind: MERGE_STEP,
            idempotencyKey: `${run.id}:merge:${result.attempt}`,
            payload: target,
            timeoutMs: MERGE_TIMEOUT_MS,
            maxAttempts: MERGE_ATTEMPTS,
          });
        }
        next = delivery.next;
        reason = `${outcome.reason}; ${delivery.reason}`;
        break;
      }
      case 'Implementing':
        await enqueueImplement(trx, run.id, run.implementAttempts + 1, outcome.feedback);
        break;
      case 'Escalated':
        await enqueueOutbox(trx, run.id, 'issue.comment', {
          repo: issue.repo,
          issueNumber: issue.issueNumber,
          body: outcome.comment,
        });
        break;
    }
    return { to: next, reason };
  });
  return run ? `run ${run.id} moved to ${run.state}` : null;
}

const mergeResult = z.discriminatedUnion('merged', [
  z.object({ done: z.literal(true), merged: z.literal(true), mergeSha: z.string() }),
  z.object({ done: z.literal(true), merged: z.literal(false), reason: z.string() }),
]);

/**
 * Merging -> Merged, or Escalated when the target's CI failed, the pull
 * request was closed, or GitHub never merged it while the step was watching.
 */
export async function applyNextMergeResult(runs: Runs): Promise<string | null> {
  const run = await runs.advanceOnFinishedStep('Merging', MERGE_STEP, async (trx, run, step) => {
    const issue = await issueOf(runs, run.id);
    const result = step.status === 'succeeded' ? mergeResult.parse(step.result) : null;
    if (result?.merged) {
      await appendAuditEvent(trx, run.id, 'delivery.merged', { mergeSha: result.mergeSha });
      return { to: 'Merged', reason: `merged as ${result.mergeSha.slice(0, 12)}` };
    }
    const why = result ? result.reason : `GitHub did not merge it: ${step.lastError ?? 'unknown error'}`;
    await appendAuditEvent(trx, run.id, 'delivery.failed', { stepId: step.id, reason: why });
    await enqueueOutbox(trx, run.id, 'issue.comment', {
      repo: issue.repo,
      issueNumber: issue.issueNumber,
      body: `The software factory passed every quality gate for this issue but could not ship it: ${why}. A person needs to take it from here; the pull request is still open.`,
    });
    return { to: 'Escalated', reason: `could not merge: ${why}` };
  });
  return run ? `run ${run.id} moved to ${run.state}` : null;
}

/**
 * Reviewing -> Merging, when the owner approves work that was held for them.
 * The approval and who gave it go in the audit log with the transition; from
 * there the run ships like any other: the outbox asks GitHub to merge once
 * the target's checks pass, and the merge step watches until it has. Returns
 * null when the run is not held (already approved, or never held), so an
 * approval sent twice does nothing the second time.
 */
export async function approveHeldRun(
  runs: Pick<RunStore, 'advanceRunWith' | 'getIssue'>,
  runId: string,
  approver: string,
): Promise<string | null> {
  const run = await runs.advanceRunWith(runId, 'Reviewing', async (trx, run) => {
    const issue = await issueOf(runs, run.id);
    const { branch } = await trx
      .selectFrom('run')
      .select('branch')
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    if (!branch) throw new Error(`run ${run.id} has no branch to merge`);
    await appendAuditEvent(trx, run.id, 'delivery.approved', { approver });
    const target = { repo: issue.repo, head: branch };
    await enqueueOutbox(trx, run.id, 'pull_request.merge', target);
    await enqueueStep(trx, {
      runId: run.id,
      kind: MERGE_STEP,
      idempotencyKey: `${run.id}:merge:approved`,
      payload: target,
      timeoutMs: MERGE_TIMEOUT_MS,
      maxAttempts: MERGE_ATTEMPTS,
    });
    return { to: 'Merging', reason: `approved by ${approver}` };
  });
  return run ? `run ${run.id} moved to ${run.state}` : null;
}

async function recordTrace(
  trx: Transaction<Database>,
  requirementId: string,
  links: readonly TraceLink[],
  commitSha: string,
): Promise<void> {
  if (links.length === 0) return;
  await trx
    .insertInto('trace_link')
    .values(
      links.map((l) => ({
        requirement_id: requirementId,
        criterion_id: l.criterionId,
        test_id: l.testId,
        commit_sha: commitSha,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['requirement_id', 'criterion_id', 'test_id']).doUpdateSet({ commit_sha: commitSha }),
    )
    .execute();
}

const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function pullRequestBody(
  issue: RunIssue,
  runId: string,
  attempt: number,
  gates: readonly GateResult[],
  links: readonly TraceLink[],
  risk: { predicted: RiskTier | null; measured: RiskTier; final: RiskTier; reasons: readonly string[] },
  delivery: DeliveryDecision,
): string {
  const testsFor = (c: AcceptanceCriterion) =>
    links
      .filter((l) => l.criterionId === c.id)
      .map((l) => `\`${l.testId}\``)
      .join('<br>');
  return [
    `Closes #${issue.issueNumber}.`,
    '',
    `Built by the software factory: run \`${runId}\`, attempt ${attempt}. Every step is in the run's audit log.`,
    '',
    '## Acceptance criteria',
    '',
    '| | Criterion | Tests |',
    '| --- | --- | --- |',
    ...issue.criteria.map((c) => `| ${c.id} | ${escapeCell(c.text)} | ${testsFor(c) || '—'} |`),
    '',
    '## Quality gates',
    '',
    '| Gate | Result |',
    '| --- | --- |',
    ...gates.map((g) => `| ${g.gate} | ${g.passed ? 'passed' : 'failed'}: ${escapeCell(g.summary)} |`),
    '',
    '## Risk',
    '',
    `**${risk.final}**. Predicted by triage: ${risk.predicted ?? 'not triaged'}; measured from the diff: ${risk.measured}.`,
    ...(risk.reasons.length > 0 ? ['', ...risk.reasons.map((r) => `- \`${r}\``)] : []),
    '',
    '## Delivery',
    '',
    delivery.next === 'Merging'
      ? "The factory merges this automatically once the repository's required checks pass, and it ships with the next deployment."
      : `Held for the owner's approval (${delivery.reason}). The owner approves it on the factory's dashboard; the factory then merges it once the repository's required checks pass.`,
  ].join('\n');
}
