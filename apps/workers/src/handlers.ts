import type { RunStore } from '@factory/db';
import type { DecisionModel } from '@factory/domain';
import { createTriageHandler, TRIAGE_STEP } from './handlers/triage.ts';
import type { StepHandler } from './step-runner.ts';

/**
 * Step handlers by kind. A worker only claims kinds listed here, so a worker
 * without a decision model simply never picks up triage.
 */
export function createHandlers(deps: {
  runs: Pick<RunStore, 'getIssue'>;
  decisionModel: DecisionModel | null;
}): Readonly<Record<string, StepHandler>> {
  const handlers: Record<string, StepHandler> = {};

  if (deps.decisionModel) {
    handlers[TRIAGE_STEP] = createTriageHandler({
      model: deps.decisionModel,
      loadIssue: (runId) => deps.runs.getIssue(runId),
    });
  }

  return handlers;
}
