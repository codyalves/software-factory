/** An issue as the factory sees it, independent of the git host. */
export interface ForgeIssue {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/**
 * Everything the factory needs from a git host. GitHub is the first
 * implementation; GitLab can follow without touching the orchestrator.
 */
export interface ForgeAdapter {
  readonly name: string;
  comment(repo: string, issueNumber: number, body: string): Promise<void>;
  openPullRequest(pr: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<number>;
  mergePullRequest(repo: string, pullNumber: number): Promise<void>;
}
