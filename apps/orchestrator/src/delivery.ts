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
  extractCriteria,
  type GateResult,
  gatingOutcome,
  higherTier,
  parseRepro,
  RISK_TIERS,
  type RiskTier,
  type TraceLink,
} from '@factory/domain';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';

export const IMPLEMENT_STEP = 'implement';
export const GATE_STEP = 'gate';

/** Implementation runs a coding agent and gates run test suites: give them room. */
const IMPLEMENT_TIMEOUT_MS = 30 * 60_000;
const GATE_TIMEOUT_MS = 30 * 60_000;

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
        await enqueueOutbox(trx, run.id, 'pull_request.open', {
          repo: issue.repo,
          head: result.branch,
          base: result.baseBranch,
          title: issue.title,
          body: pullRequestBody(issue, run.id, result.attempt, gates, result.links, risk),
        });
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
    return { to: outcome.next, reason: outcome.reason };
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
  ].join('\n');
}
