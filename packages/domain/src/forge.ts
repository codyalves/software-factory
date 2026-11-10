/** An issue as the factory sees it, independent of the git host. */
export interface ForgeIssue {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  /** Login of whoever opened it, when known. Decides whether an embedded regression test is trusted. */
  readonly author?: string;
}

export interface IssueComment {
  readonly repo: string;
  readonly issueNumber: number;
  readonly body: string;
  /** Identifies this comment, so a retry can find it instead of posting twice. */
  readonly dedupeKey: string;
  /** True on a retry, when an earlier attempt may have posted before failing. */
  readonly mayAlreadyExist: boolean;
}

export interface PullRequestDraft {
  readonly repo: string;
  /** The factory branch, in the same repository. */
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  /** True on a retry, when an earlier attempt may have opened it before failing. */
  readonly mayAlreadyExist: boolean;
}

export interface IssueDraft {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  /** The finding's fingerprint; the body carries it too, so a retry can find the issue. */
  readonly fingerprint: string;
  /** True on a retry, when an earlier attempt may have created it before failing. */
  readonly mayAlreadyExist: boolean;
}

export interface OpenFinding {
  readonly number: number;
  readonly url: string;
  readonly fingerprint: string;
}

/**
 * Everything the factory needs from a git host. GitHub is the first
 * implementation; GitLab can follow without touching the orchestrator.
 */
export interface ForgeAdapter {
  readonly name: string;
  comment(comment: IssueComment): Promise<{ url: string; reused: boolean }>;
  /** Opens a pull request, or returns the one already open for `head` on a retry. */
  openPullRequest(pr: PullRequestDraft): Promise<{ number: number; url: string; reused: boolean }>;
  mergePullRequest(repo: string, pullNumber: number): Promise<void>;
  /** Files an issue, or returns the open one with the same fingerprint on a retry. */
  createIssue(issue: IssueDraft): Promise<{ number: number; url: string; reused: boolean }>;
  /** Open issues the tester filed, by fingerprint, for deduplication. */
  openFindings(repo: string): Promise<OpenFinding[]>;
}
