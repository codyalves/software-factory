import { setTimeout as sleep } from 'node:timers/promises';
import type { RunStore } from '@factory/db';

export interface IntakeLoopOptions {
  readonly runs: Pick<RunStore, 'advanceNext'>;
  readonly idleDelayMs: number;
  readonly signal: AbortSignal;
  readonly log: Pick<Console, 'info' | 'error'>;
}

/**
 * M0: claims runs waiting in Intake and moves them to Triage, recording each
 * transition. M1 replaces this with the full state machine driven by queued
 * steps, the decision layer and gate results.
 */
export async function runIntakeLoop({ runs, idleDelayMs, signal, log }: IntakeLoopOptions): Promise<void> {
  while (!signal.aborted) {
    try {
      const run = await runs.advanceNext('Intake', 'Triage', 'picked up by orchestrator');
      if (run) {
        log.info(`run ${run.id} moved to ${run.state}`);
        continue;
      }
    } catch (error) {
      log.error('intake loop iteration failed', error);
    }

    await sleep(idleDelayMs, undefined, { signal }).catch(() => {});
  }
}
