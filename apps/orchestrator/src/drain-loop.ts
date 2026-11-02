import { setTimeout as sleep } from 'node:timers/promises';

export interface DrainLoopOptions {
  readonly name: string;
  /** Does one unit of work and describes it, or returns null when there is none. */
  readonly next: () => Promise<string | null>;
  readonly idleDelayMs: number;
  readonly signal: AbortSignal;
  readonly log: Pick<Console, 'info' | 'error'>;
}

/**
 * Works through everything waiting, then idles until the next poll. A failed
 * iteration is logged and the loop carries on.
 */
export async function runDrainLoop({
  name,
  next,
  idleDelayMs,
  signal,
  log,
}: DrainLoopOptions): Promise<void> {
  while (!signal.aborted) {
    try {
      const done = await next();
      if (done !== null) {
        log.info(done);
        continue;
      }
    } catch (error) {
      log.error(`${name} iteration failed`, error);
    }

    await sleep(idleDelayMs, undefined, { signal }).catch(() => {});
  }
}
