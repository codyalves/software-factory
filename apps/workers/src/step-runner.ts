import { setTimeout as sleep } from 'node:timers/promises';
import type { Step, StepFailure, StepQueue } from '@factory/db';
import { classifyFailure, type FailureClass, type ModelUsage } from '@factory/domain';

/**
 * Thrown by a handler to state how its failure should be treated. Anything
 * else thrown is classified from the error itself (timeouts, network codes,
 * HTTP status).
 */
export class StepError extends Error {
  readonly failureClass: FailureClass | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly details: unknown;

  constructor(
    message: string,
    options: {
      failureClass?: FailureClass;
      status?: number;
      retryAfterMs?: number;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'StepError';
    this.failureClass = options.failureClass;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

/**
 * Does the work for one kind of step. Must stop promptly when the signal
 * aborts (timeout or lost lease); its result is discarded in that case.
 */
export type StepHandler = (
  step: Step,
  context: {
    signal: AbortSignal;
    /** Report every billed model call; it lands in the cost ledger even if the step fails. */
    recordUsage: (usage: ModelUsage) => void;
  },
) => Promise<unknown>;

/** Whether the worker may take new work right now (pause switch, budget). */
export type WorkGate = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface StepRunnerOptions {
  readonly queue: Pick<StepQueue, 'claim' | 'heartbeat' | 'complete' | 'fail' | 'recordUsage'>;
  readonly worker: string;
  readonly handlers: Readonly<Record<string, StepHandler>>;
  readonly leaseMs: number;
  readonly idleDelayMs: number;
  /** Stops claiming new work. A step already running is allowed to finish. */
  readonly signal: AbortSignal;
  readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Checked before every claim. A blocked gate leaves work queued. */
  readonly canClaim?: () => Promise<WorkGate>;
}

export async function runSteps(options: StepRunnerOptions): Promise<void> {
  const kinds = Object.keys(options.handlers);
  if (kinds.length === 0) {
    options.log.warn('no step handlers registered; nothing to do');
  }

  let blockedBy: string | null = null;

  while (!options.signal.aborted) {
    const gate: WorkGate = options.canClaim
      ? await options.canClaim().catch((error: unknown) => ({
          ok: false as const,
          reason: `could not check the pause switch and budget: ${String(error)}`,
        }))
      : { ok: true };

    if (!gate.ok) {
      if (blockedBy !== gate.reason) {
        options.log.info(`not taking new work: ${gate.reason}`);
        blockedBy = gate.reason;
      }
      await sleep(options.idleDelayMs, undefined, { signal: options.signal }).catch(() => {});
      continue;
    }
    if (blockedBy !== null) {
      options.log.info('taking new work again');
      blockedBy = null;
    }

    let step: Step | null = null;
    try {
      step = await options.queue.claim(options.worker, kinds, options.leaseMs);
    } catch (error) {
      options.log.error('claim failed', error);
    }

    if (step) {
      await executeStep(step, options);
      continue;
    }

    await sleep(options.idleDelayMs, undefined, { signal: options.signal }).catch(() => {});
  }
}

/** Runs one claimed step to completion and reports the outcome. Exported for tests. */
export async function executeStep(step: Step, options: StepRunnerOptions): Promise<void> {
  const { queue, worker, log } = options;
  const handler = options.handlers[step.kind];
  const leaseLost = new AbortController();
  const timeout = AbortSignal.timeout(step.timeoutMs);
  const signal = AbortSignal.any([leaseLost.signal, timeout]);
  const usage: ModelUsage[] = [];
  const recordUsage = (entry: ModelUsage) => {
    usage.push(entry);
  };

  // Heartbeat at a third of the lease, so two can be missed before it expires.
  const heartbeat = setInterval(() => {
    queue.heartbeat(step.id, worker, options.leaseMs).then(
      (held) => {
        if (!held) leaseLost.abort(new Error('lease lost'));
      },
      (error: unknown) => log.warn(`heartbeat failed for step ${step.id}`, error),
    );
  }, options.leaseMs / 3);

  try {
    if (!handler) {
      throw new StepError(`no handler for step kind ${step.kind}`, { failureClass: 'permanent' });
    }
    // Race the abort, so a handler that ignores its signal cannot hold the worker past the deadline.
    const result = await Promise.race([handler(step, { signal, recordUsage }), rejectOnAbort(signal)]);
    if (leaseLost.signal.aborted) {
      log.warn(`step ${step.id} finished after its lease was lost; result discarded`);
      return;
    }
    if (!(await queue.complete(step.id, worker, result))) {
      log.warn(`step ${step.id} lost its lease before completing; result discarded`);
    }
  } catch (error) {
    if (leaseLost.signal.aborted) {
      log.warn(`step ${step.id} stopped: lease lost`);
      return;
    }
    const failure = toFailure(error, timeout.aborted);
    const decision = await queue.fail(step.id, worker, failure);
    log.info(
      `step ${step.id} (${step.kind}) attempt ${step.attempt} failed: ${failure.message} -> ${
        decision === null ? 'lease lost' : decision.retry ? 'retry scheduled' : 'dead-lettered'
      }`,
    );
  } finally {
    clearInterval(heartbeat);
    // Spend is recorded whatever happened to the step: the tokens were billed.
    if (usage.length > 0) {
      await queue.recordUsage(step, usage).catch((error: unknown) => {
        log.error(`could not record usage for step ${step.id}`, error);
      });
    }
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toFailure(error: unknown, timedOut: boolean): StepFailure {
  const message = error instanceof Error ? error.message : String(error);

  if (timedOut) {
    return { failureClass: 'timeout', message: `step timed out: ${message}` };
  }
  if (error instanceof StepError) {
    return {
      failureClass:
        error.failureClass ??
        classifyFailure(error.status === undefined ? { error } : { error, status: error.status }),
      message,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { failureClass: classifyFailure({ error }), message };
}
