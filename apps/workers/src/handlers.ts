import type { RunStore } from '@factory/db';
import type { DecisionModel } from '@factory/domain';
import type { TargetConfig } from './gates.ts';
import { createGateHandler, createImplementHandler, GATE_STEP, IMPLEMENT_STEP } from './handlers/delivery.ts';
import { createTriageHandler, TRIAGE_STEP } from './handlers/triage.ts';
import type { Implementer } from './implementer.ts';
import type { StepHandler } from './step-runner.ts';
import type { RepoAccess } from './workspace.ts';

/**
 * Step handlers by kind. A worker only claims kinds listed here, so a worker
 * without a decision model simply never picks up triage.
 */
export function createHandlers(deps: {
  runs: Pick<RunStore, 'getIssue'>;
  decisionModel: DecisionModel | null;
  /** Target repos and git access; without them the worker takes no gate or implement steps. */
  delivery?: {
    targets: Readonly<Record<string, TargetConfig>>;
    access: RepoAccess;
    implementer: Implementer | null;
  } | null;
}): Readonly<Record<string, StepHandler>> {
  const handlers: Record<string, StepHandler> = {};

  if (deps.decisionModel) {
    handlers[TRIAGE_STEP] = createTriageHandler({
      model: deps.decisionModel,
      loadIssue: (runId) => deps.runs.getIssue(runId),
    });
  }

  if (deps.delivery) {
    const delivery = { ...deps.delivery, loadIssue: (runId: string) => deps.runs.getIssue(runId) };
    handlers[GATE_STEP] = createGateHandler(delivery);
    if (deps.delivery.implementer) {
      handlers[IMPLEMENT_STEP] = createImplementHandler({
        ...delivery,
        implementer: deps.delivery.implementer,
      });
    }
  }

  return handlers;
}
