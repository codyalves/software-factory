import { setTimeout as sleep } from 'node:timers/promises';
import { type ForgeAdapter, mergeProgress } from '@factory/domain';
import { z } from 'zod';
import { StepError, type StepHandler } from '../step-runner.ts';

export const MERGE_STEP = 'merge';

const mergePayload = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  head: z.string().min(1),
});

export interface MergeWaitOptions {
  readonly forge: Pick<ForgeAdapter, 'pullRequestStatus'>;
  /** Between looks at the pull request. */
  readonly pollMs?: number;
  /** How long one step attempt watches before handing back to the queue to retry. */
  readonly waitMs?: number;
}

/**
 * Watches a pull request the factory asked GitHub to merge, until GitHub has
 * merged it or its checks failed. Only reads: the merge request itself went
 * out through the outbox. A wait that runs out is transient, so the queue
 * tries again, and a person takes over when its attempts are spent.
 */
export function createMergeHandler(options: MergeWaitOptions): StepHandler {
  const pollMs = options.pollMs ?? 20_000;
  const waitMs = options.waitMs ?? 20 * 60_000;
  return async (step, { signal }) => {
    const { repo, head } = mergePayload.parse(step.payload);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const progress = mergeProgress(await options.forge.pullRequestStatus(repo, head));
      if (progress.done) return progress;
      if (Date.now() + pollMs > deadline) {
        throw new StepError(`${repo} ${head} has not merged yet; its checks are still running`, {
          failureClass: 'transient',
        });
      }
      await sleep(pollMs, undefined, { signal });
    }
  };
}
