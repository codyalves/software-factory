import { isRunState, isTerminal } from '@factory/domain';

/** The part of a run the status page needs (a `RunListItem` fits). */
export interface StatusRun {
  readonly id: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly state: string;
  readonly implementAttempts: number;
  readonly spentUsd: number;
  readonly pullRequestUrl: string | null;
  readonly updatedAt: string;
}

export interface StatusView {
  /** Being worked on by the session that is running now. */
  readonly current: readonly StatusRun[];
  /** Finished or held since the running session started, most recently changed first. */
  readonly session: readonly StatusRun[];
  /** Started and not finished, with no session working on them: a session ended or was stopped first. */
  readonly unfinished: readonly StatusRun[];
  /** Finished or held before that, most recently changed first. */
  readonly outcomes: readonly StatusRun[];
}

function moving(state: string): boolean {
  return isRunState(state) && !isTerminal(state) && state !== 'Reviewing';
}

/**
 * Sorts the latest run of each issue into what is happening now, what this
 * session has finished, what was left behind, and what came before. `runs` is
 * newest first, as the record lists them. A run belongs to the running session
 * only if it changed since that session started: sessions share one slot
 * across projects, so a run nobody has touched since then is an earlier
 * session's. With `sessionKnown` false (GitHub could not say whether a session
 * is running) a moving run is shown as current rather than as left behind.
 */
export function statusView(
  runs: readonly StatusRun[],
  sessionStartedAt: string | null,
  { sessionKnown = true, outcomeLimit = 6 }: { sessionKnown?: boolean; outcomeLimit?: number } = {},
): StatusView {
  const seen = new Set<string>();
  const latest = runs.filter((r) => {
    const key = `${r.repo}#${r.issueNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const inSession = (r: StatusRun) =>
    sessionStartedAt !== null && Date.parse(r.updatedAt) >= Date.parse(sessionStartedAt);
  const active = latest.filter((r) => moving(r.state));
  const done = latest
    .filter((r) => !moving(r.state))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    current: active.filter((r) => !sessionKnown || inSession(r)),
    session: done.filter(inSession),
    unfinished: active.filter((r) => sessionKnown && !inSession(r)),
    outcomes: done.filter((r) => !inSession(r)).slice(0, outcomeLimit),
  };
}

/** What a session has to show so far: issues shipped, and issues that stopped short of that. */
export function sessionTally(session: readonly StatusRun[]): { shipped: number; stopped: number } {
  const shipped = session.filter((r) => r.state === 'Merged').length;
  return { shipped, stopped: session.length - shipped };
}

const STEP_PROJECT = /^(?:Work through|Run the factory on) ([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/;

/**
 * The project a running session is working on. Sessions share one slot, and
 * the project is an input GitHub does not report on a workflow run, so it is
 * read from the step the workflows name after it ("Work through owner/repo
 * (label)", "Run the factory on owner/repo#12"). Failing that, it is the
 * project of the run that changed most recently since the session started.
 */
export function sessionProject(
  stepNames: readonly string[],
  runs: readonly StatusRun[],
  sessionStartedAt: string,
): string | null {
  for (const name of stepNames) {
    const match = STEP_PROJECT.exec(name);
    if (match?.[1]) return match[1];
  }
  const since = Date.parse(sessionStartedAt);
  const touched = runs
    .filter((r) => Date.parse(r.updatedAt) >= since)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return touched[0]?.repo ?? null;
}

/** A factory workflow run on GitHub Actions, running or finished. */
export interface SessionRecord {
  readonly id: number;
  readonly workflow: string;
  /** GitHub's status: queued, in_progress, completed and a few waiting states. */
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** The session holding the slot now, if any, and the last one that finished. `records` is newest first. */
export function splitSessions(records: readonly SessionRecord[]): {
  active: SessionRecord | null;
  last: SessionRecord | null;
} {
  return {
    active: records.find((r) => r.status !== 'completed') ?? null,
    last: records.find((r) => r.status === 'completed') ?? null,
  };
}

/** The step a session's job is on, by the name the workflow gives it. */
export function currentStep(
  steps: readonly { readonly name: string; readonly status: string }[],
): string | null {
  return steps.find((s) => s.status === 'in_progress')?.name ?? null;
}

export type CheckState = 'success' | 'failure' | 'pending' | 'none';

/** GitHub's many words for a check, status or deployment, as the four a reader needs. */
export function checkState(state: string | null | undefined): CheckState {
  if (!state) return 'none';
  // A superseded deployment reads INACTIVE; it did deploy.
  if (state === 'SUCCESS' || state === 'INACTIVE') return 'success';
  if (state === 'FAILURE' || state === 'ERROR') return 'failure';
  return 'pending';
}

export interface SiteCommit {
  readonly sha: string;
  readonly headline: string;
  readonly at: string;
  readonly url: string;
  readonly checks: CheckState;
  readonly deploy: CheckState;
}

export interface SitePull {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly draft: boolean;
  readonly branch: string;
  readonly openedAt: string;
  readonly checks: CheckState;
}

export interface SiteState {
  /** The base branch, newest first. The first commit is what production should be running. */
  readonly commits: readonly SiteCommit[];
  readonly pulls: readonly SitePull[];
  /** Open issues carrying the ready label: the backlog, counting any issue in progress. */
  readonly readyIssues: number;
}

/** The shape of SITE_QUERY's answer (lib/control.ts). */
export interface SiteQueryData {
  readonly repository: {
    readonly issues: { readonly totalCount: number };
    readonly pullRequests: {
      readonly nodes: readonly {
        readonly number: number;
        readonly title: string;
        readonly url: string;
        readonly isDraft: boolean;
        readonly createdAt: string;
        readonly headRefName: string;
        readonly commits: {
          readonly nodes: readonly {
            readonly commit: { readonly statusCheckRollup: { readonly state: string } | null };
          }[];
        };
      }[];
    };
    readonly ref: {
      readonly target: {
        readonly history?: {
          readonly nodes: readonly {
            readonly oid: string;
            readonly messageHeadline: string;
            readonly committedDate: string;
            readonly url: string;
            readonly statusCheckRollup: { readonly state: string } | null;
            readonly status: {
              readonly contexts: readonly { readonly context: string; readonly state: string }[];
            } | null;
            readonly deployments: {
              readonly nodes: readonly { readonly latestStatus: { readonly state: string } | null }[];
            } | null;
          }[];
        };
      } | null;
    } | null;
  } | null;
}

/**
 * What GitHub knows about the target: its open pull requests and the latest
 * commits on its base branch, each with its checks and its production deploy.
 * The deploy is read the way the factory reads it (`deploymentState`): a
 * deployment to the production environment if the host reports one, otherwise
 * the commit status the host posts (`statusContext`, "Vercel" for Vercel).
 */
export function siteState(data: SiteQueryData, statusContext: string): SiteState {
  const repo = data.repository;
  return {
    commits: (repo?.ref?.target?.history?.nodes ?? []).map((c) => {
      const deployment = c.deployments?.nodes[0];
      const status = c.status?.contexts.find((s) => s.context === statusContext);
      return {
        sha: c.oid,
        headline: c.messageHeadline,
        at: c.committedDate,
        url: c.url,
        checks: checkState(c.statusCheckRollup?.state),
        deploy: deployment
          ? checkState(deployment.latestStatus?.state ?? 'PENDING')
          : checkState(status?.state),
      };
    }),
    pulls: (repo?.pullRequests.nodes ?? []).map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      draft: p.isDraft,
      branch: p.headRefName,
      openedAt: p.createdAt,
      checks: checkState(p.commits.nodes[0]?.commit.statusCheckRollup?.state),
    })),
    readyIssues: repo?.issues.totalCount ?? 0,
  };
}
