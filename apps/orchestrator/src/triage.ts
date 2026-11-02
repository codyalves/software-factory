import { appendAuditEvent, enqueueOutbox, enqueueStep, type RunStore } from '@factory/db';
import { type Decision, isConfident, triageOutcome } from '@factory/domain';
import { z } from 'zod';

export const TRIAGE_STEP = 'triage';

const triageResult = z.object({
  decisions: z.array(
    z.object({
      question: z.string(),
      choice: z.string(),
      probability: z.number(),
      engine: z.string(),
      engineVersion: z.string(),
      promptVersion: z.string().nullable(),
      // Absent on results written before questions were versioned.
      questionVersion: z.string().nullable().default(null),
    }),
  ),
});

/** Intake -> Triage, queueing the triage step in the same transaction. */
export async function startNextTriage(runs: Pick<RunStore, 'advanceNext'>): Promise<string | null> {
  const run = await runs.advanceNext('Intake', 'Triage', 'picked up by orchestrator', async (trx, run) => {
    await enqueueStep(trx, { runId: run.id, kind: TRIAGE_STEP, idempotencyKey: `${run.id}:triage` });
  });
  return run ? `run ${run.id} moved to Triage; triage step queued` : null;
}

/**
 * Applies a finished triage step to its run: records every decision, applies
 * the triage rules and their fallbacks, sets the risk tier, queues a comment
 * for the issue author when one is needed, and moves the run, all in one
 * transaction. A dead-lettered triage step escalates the run to a human.
 */
export async function applyNextTriageResult(
  runs: Pick<RunStore, 'advanceOnFinishedStep' | 'getIssue'>,
  confidenceThreshold: number,
): Promise<string | null> {
  const moved = await runs.advanceOnFinishedStep('Triage', TRIAGE_STEP, async (trx, run, step) => {
    const issue = await runs.getIssue(run.id);
    if (!issue) {
      throw new Error(`run ${run.id} has no issue`);
    }

    if (step.status === 'dead_lettered') {
      await appendAuditEvent(trx, run.id, 'triage.failed', { stepId: step.id, error: step.lastError });
      return { to: 'Escalated', reason: `triage could not run: ${step.lastError ?? 'unknown error'}` };
    }

    const { decisions } = triageResult.parse(step.result);
    for (const decision of decisions satisfies Decision[]) {
      await appendAuditEvent(trx, run.id, 'decision.made', {
        stepId: step.id,
        ...decision,
        threshold: confidenceThreshold,
        confident: isConfident(decision, confidenceThreshold),
      });
    }

    const outcome = triageOutcome(decisions, confidenceThreshold);

    await trx
      .updateTable('requirement')
      .set({ risk_level: outcome.riskTier })
      .where('id', '=', issue.requirementId)
      .execute();

    await appendAuditEvent(trx, run.id, 'triage.completed', {
      stepId: step.id,
      next: outcome.next,
      riskTier: outcome.riskTier,
      riskFactors: outcome.riskFactors,
      reason: outcome.reason,
      fallbacks: outcome.fallbacks,
    });

    if (outcome.comment) {
      await enqueueOutbox(trx, run.id, 'issue.comment', {
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        body: outcome.comment,
      });
    }

    return { to: outcome.next, reason: outcome.reason };
  });

  return moved ? `run ${moved.id} triaged: ${moved.state}` : null;
}
