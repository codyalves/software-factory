import type { RunIssue } from '@factory/db';
import { DecisionError } from '@factory/decisions';
import { type Decision, type DecisionModel, TRIAGE_QUESTIONS } from '@factory/domain';
import { StepError, type StepHandler } from '../step-runner.ts';

export const TRIAGE_STEP = 'triage';

/** What a triage step leaves in step.result for the orchestrator. */
export interface TriageResult {
  readonly decisions: readonly Decision[];
}

export interface TriageDependencies {
  readonly model: DecisionModel;
  readonly loadIssue: (runId: string) => Promise<RunIssue | null>;
}

/**
 * Asks the decision layer every triage question about the run's issue.
 * It only answers; the orchestrator records the decisions and moves the run.
 */
export function createTriageHandler(deps: TriageDependencies): StepHandler {
  return async (step, { signal, recordUsage }) => {
    const issue = await deps.loadIssue(step.runId);
    if (!issue) {
      throw new StepError(`no issue found for run ${step.runId}`, { failureClass: 'permanent' });
    }

    const material = [
      `Repository: ${issue.repo}`,
      `Issue #${issue.issueNumber}: ${issue.title}`,
      '',
      issue.body,
    ].join('\n');

    try {
      const decisions = await Promise.all(
        TRIAGE_QUESTIONS.map((question) =>
          deps.model.decide(question, material, { signal, onUsage: recordUsage }),
        ),
      );
      return { decisions } satisfies TriageResult;
    } catch (error) {
      if (error instanceof DecisionError) {
        throw new StepError(error.message, {
          failureClass: error.retryable ? 'transient' : 'permanent',
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          cause: error,
        });
      }
      throw error;
    }
  };
}
