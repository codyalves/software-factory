import {
  type BacklogIssue,
  isRunState,
  isTerminal,
  NEEDS_OWNER_LABEL,
  nextFromBacklog,
  READY_LABEL,
} from '@factory/domain';

export interface LatestRun {
  readonly id: string;
  readonly state: string;
  readonly pullRequestUrl: string | null;
}

export interface BacklogRow {
  readonly number: number;
  readonly title: string;
  readonly run: LatestRun | null;
}

export interface BacklogView {
  /** What the next session will take, in order, if each one ships. */
  readonly next: readonly BacklogRow[];
  /** Being worked on now. */
  readonly running: readonly BacklogRow[];
  /** Ready, but waiting on open issues that are not in the queue ahead of them. */
  readonly blocked: readonly (BacklogRow & { readonly on: readonly number[] })[];
  /** Tried and not shipped: held for review, escalated, rejected or cancelled. */
  readonly owner: readonly BacklogRow[];
}

/**
 * The backlog as the factory sees it, using the same rules as the backlog
 * runner (`nextFromBacklog`), not a copy of them. The order assumes each issue
 * ships and closes, which is what lets the ones that depend on it go next.
 */
export function backlogView(
  issues: readonly BacklogIssue[],
  latestRuns: ReadonlyMap<number, LatestRun>,
): BacklogView {
  const row = (i: BacklogIssue): BacklogRow => ({
    number: i.number,
    title: i.title,
    run: latestRuns.get(i.number) ?? null,
  });
  const active = (i: BacklogIssue) => {
    const state = latestRuns.get(i.number)?.state;
    return !!state && isRunState(state) && !isTerminal(state);
  };

  const owner = issues.filter(
    (i) =>
      i.labels.includes(NEEDS_OWNER_LABEL) || (active(i) && latestRuns.get(i.number)?.state === 'Reviewing'),
  );
  const running = issues.filter(
    (i) => i.labels.includes(READY_LABEL) && active(i) && latestRuns.get(i.number)?.state !== 'Reviewing',
  );
  const settled = new Set([...owner, ...running].map((i) => i.number));
  const candidates = issues.filter((i) => !settled.has(i.number));

  const open = new Set(issues.map((i) => i.number));
  const queued = new Set<number>();
  const next: BacklogRow[] = [];
  let blocked: readonly { number: number; on: readonly number[] }[] = [];
  for (;;) {
    const choice = nextFromBacklog(candidates, open, queued);
    blocked = choice.blocked;
    if (!choice.next) break;
    next.push(row(choice.next));
    queued.add(choice.next.number);
    open.delete(choice.next.number);
  }

  const byNumber = new Map(issues.map((i) => [i.number, i]));
  return {
    next,
    running: running.map(row),
    blocked: blocked.flatMap((b) => {
      const issue = byNumber.get(b.number);
      return issue ? [{ ...row(issue), on: b.on }] : [];
    }),
    owner: owner.sort((a, b) => a.number - b.number).map(row),
  };
}
