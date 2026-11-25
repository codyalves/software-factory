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
  /** Started and not finished, with no session working on them: a session ended or was stopped first. */
  readonly unfinished: readonly StatusRun[];
  /** Finished or held for the owner, most recently changed first. */
  readonly outcomes: readonly StatusRun[];
}

function moving(state: string): boolean {
  return isRunState(state) && !isTerminal(state) && state !== 'Reviewing';
}

/**
 * Sorts the latest run of each issue into what is happening now, what was
 * left behind, and what is done. `runs` is newest first, as the record lists
 * them. A run counts as current only if it changed since the active session
 * started: sessions share one slot across projects, so a run nobody has
 * touched since then belongs to an earlier session, not this one.
 */
export function statusView(
  runs: readonly StatusRun[],
  sessionStartedAt: string | null,
  outcomeLimit = 6,
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
  return {
    current: active.filter(inSession),
    unfinished: active.filter((r) => !inSession(r)),
    outcomes: latest
      .filter((r) => !moving(r.state))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, outcomeLimit),
  };
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
}

/** The shape of SITE_QUERY's answer (lib/control.ts). */
export interface SiteQueryData {
  readonly repository: {
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
  };
}
