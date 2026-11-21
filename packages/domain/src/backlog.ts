/**
 * Which issue the factory takes next when it works through a backlog. Pure;
 * the backlog runner reads the issues and runs each one like a manual run.
 */

import { isRunState, isTerminal } from './run-state-machine.ts';

/** Issues with this label are ready for the factory. */
export const READY_LABEL = 'factory:ready';

/** The owner's queue: work the factory tried and could not ship on its own. */
export const NEEDS_OWNER_LABEL = 'needs-owner';

export interface BacklogIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

const DEPENDENCY_LINE = /\b(?:depends on|blocked by|after)\b([^\n]*)/gi;

/**
 * Issues this one waits for, from lines like "Depends on #6" or
 * "Blocked by #3 and #4". A dependency is met once its issue is closed.
 */
export function dependencies(body: string): number[] {
  const found = new Set<number>();
  for (const line of body.matchAll(DEPENDENCY_LINE)) {
    for (const ref of (line[1] ?? '').matchAll(/#(\d+)/g)) found.add(Number(ref[1]));
  }
  return [...found].sort((a, b) => a - b);
}

export interface BacklogChoice {
  /** The oldest ready issue whose dependencies are all closed, or null. */
  readonly next: BacklogIssue | null;
  /** Ready issues still waiting, and on which open issues. */
  readonly blocked: readonly { readonly number: number; readonly on: readonly number[] }[];
}

/**
 * The next issue to run: ready, not tried yet in this session, and not
 * waiting on an open issue. Oldest first, so work lands in the order it was
 * written down.
 *
 * @param openNumbers Every open issue in the repository, ready or not.
 * @param tried Issues this session already ran, whatever happened to them.
 */
export function nextFromBacklog(
  issues: readonly BacklogIssue[],
  openNumbers: ReadonlySet<number>,
  tried: ReadonlySet<number> = new Set(),
  label: string = READY_LABEL,
): BacklogChoice {
  const blocked: { number: number; on: number[] }[] = [];
  const ready = issues
    .filter((i) => i.labels.includes(label) && openNumbers.has(i.number) && !tried.has(i.number))
    .sort((a, b) => a.number - b.number);
  for (const issue of ready) {
    const waitingOn = dependencies(issue.body).filter((n) => n !== issue.number && openNumbers.has(n));
    if (waitingOn.length === 0) return { next: issue, blocked };
    blocked.push({ number: issue.number, on: waitingOn });
  }
  return { next: null, blocked };
}

/**
 * What the backlog does with a ready issue, given the state of its latest
 * run. Only one session runs at a time, so an unfinished run that is not
 * waiting for the owner was left by a session that stopped: it is cancelled
 * and the issue runs again. A run held for review is the owner's to finish.
 */
export function previousRunAction(state: string | null): 'run' | 'held' | 'cancel-and-run' {
  if (state === null || !isRunState(state) || isTerminal(state)) return 'run';
  return state === 'Reviewing' ? 'held' : 'cancel-and-run';
}

/** After a run, whether the issue leaves the ready queue for the owner's. */
export function needsOwnerAfter(state: string): boolean {
  return state === 'Reviewing' || state === 'Escalated' || state === 'Rejected' || state === 'Cancelled';
}
