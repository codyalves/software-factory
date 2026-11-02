/** An issue as the factory sees it, independent of the git host. */
export interface ForgeIssue {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
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

/**
 * Everything the factory needs from a git host. GitHub is the first
 * implementation; GitLab can follow without touching the orchestrator.
 */
export interface ForgeAdapter {
  readonly name: string;
  comment(comment: IssueComment): Promise<{ url: string; reused: boolean }>;
  openPullRequest(pr: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
  mergePullRequest(repo: string, pullNumber: number): Promise<void>;
}
