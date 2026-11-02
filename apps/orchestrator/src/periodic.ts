import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Calls `task` every `intervalMs` until the signal aborts. A failed run is
 * logged and the next one goes ahead; one bad iteration never stops the loop.
 */
export async function runPeriodically(
  name: string,
  task: () => Promise<void>,
  options: { intervalMs: number; signal: AbortSignal; log: Pick<Console, 'error'> },
): Promise<void> {
  while (!options.signal.aborted) {
    try {
      await task();
    } catch (error) {
      options.log.error(`${name} failed`, error);
    }
    await sleep(options.intervalMs, undefined, { signal: options.signal }).catch(() => {});
  }
}
