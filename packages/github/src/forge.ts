import {
  type ForgeAdapter,
  type ForgeIssue,
  type IssueComment,
  type IssueDraft,
  type MergeRequest,
  type OpenFinding,
  type PullRequestDraft,
  type PullRequestStatus,
  parseFingerprint,
  type RevertRequest,
} from '@factory/domain';
import type { GitHubAppAuth } from './app-auth.ts';
import { type Fetch, ForgeError, githubRequest } from './client.ts';

/** Hidden in every comment the factory posts, so a retry can recognize its own earlier post. */
export function dedupeMarker(key: string): string {
  return `<!-- software-factory:${key} -->`;
}

/** Check conclusions that mean the check failed. */
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
]);

const REVERT_PULL_REQUEST = `mutation ($id: ID!, $title: String!, $body: String!) {
  revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) {
    revertPullRequest { number url headRefName }
  }
}`;

const ENABLE_AUTO_MERGE = `mutation ($id: ID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId }
}`;

interface PullRow {
  number: number;
  node_id: string;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string };
}

function toDeployState(
  state: string | undefined,
  url: string | null | undefined,
): { state: 'pending' | 'success' | 'failure'; url: string | null } {
  if (state === 'success') return { state: 'success', url: url || null };
  if (state === 'failure' || state === 'error') return { state: 'failure', url: url || null };
  return { state: 'pending', url: url || null };
}

/** Comments scanned for a marker on retry. Retries happen within minutes, so recent pages suffice. */
const MAX_COMMENT_PAGES = 10;

export interface GitHubForgeOptions {
  readonly auth: Pick<GitHubAppAuth, 'tokenFor'>;
  readonly fetch?: Fetch;
  readonly baseUrl?: string;
}

/** The forge adapter for GitHub, acting as the factory's GitHub App. */
export class GitHubForge implements ForgeAdapter {
  readonly name = 'github';
  readonly #auth: Pick<GitHubAppAuth, 'tokenFor'>;
  readonly #fetch: Fetch;
  readonly #baseUrl: string;

  constructor(options: GitHubForgeOptions) {
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = options.baseUrl ?? 'https://api.github.com';
  }

  /**
   * Posts a comment carrying a hidden dedupe marker. On a retry, it first
   * looks for an earlier comment with the same marker (the previous attempt
   * may have succeeded before its outcome was recorded), making delivery
   * effectively once.
   */
  async comment(comment: IssueComment): Promise<{ url: string; reused: boolean }> {
    const request = await this.#request(comment.repo);
    const marker = dedupeMarker(comment.dedupeKey);
    const path = `/repos/${comment.repo}/issues/${comment.issueNumber}/comments`;

    if (comment.mayAlreadyExist) {
      for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
        const comments = await githubRequest<{ body?: string; html_url: string }[]>(
          request,
          'GET',
          `${path}?per_page=100&page=${page}`,
        );
        const existing = comments.find((c) => c.body?.includes(marker));
        if (existing) {
          return { url: existing.html_url, reused: true };
        }
        if (comments.length < 100) {
          break;
        }
      }
    }

    const created = await githubRequest<{ html_url: string }>(request, 'POST', path, {
      body: `${comment.body}\n\n${marker}`,
    });
    return { url: created.html_url, reused: false };
  }

  async openPullRequest(pr: PullRequestDraft): Promise<{ number: number; url: string; reused: boolean }> {
    if (pr.mayAlreadyExist) {
      const existing = await this.#openPullFor(pr.repo, pr.head);
      if (existing) return { ...existing, reused: true };
    }
    try {
      const created = await githubRequest<{ number: number; html_url: string }>(
        await this.#request(pr.repo),
        'POST',
        `/repos/${pr.repo}/pulls`,
        { title: pr.title, head: pr.head, base: pr.base, body: pr.body },
      );
      return { number: created.number, url: created.html_url, reused: false };
    } catch (error) {
      // 422 when a pull request for this head already exists, e.g. opened by
      // an attempt whose response was lost: find it rather than fail.
      if (error instanceof ForgeError && error.status === 422) {
        const existing = await this.#openPullFor(pr.repo, pr.head);
        if (existing) return { ...existing, reused: true };
      }
      throw error;
    }
  }

  async #openPullFor(repo: string, head: string): Promise<{ number: number; url: string } | null> {
    const owner = repo.split('/')[0];
    const pulls = await githubRequest<{ number: number; html_url: string }[]>(
      await this.#request(repo),
      'GET',
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
    );
    const first = pulls[0];
    return first ? { number: first.number, url: first.html_url } : null;
  }

  async createIssue(issue: IssueDraft): Promise<{ number: number; url: string; reused: boolean }> {
    if (issue.mayAlreadyExist) {
      const existing = (await this.openFindings(issue.repo)).find((f) => f.fingerprint === issue.fingerprint);
      if (existing) return { number: existing.number, url: existing.url, reused: true };
    }
    const created = await githubRequest<{ number: number; html_url: string }>(
      await this.#request(issue.repo),
      'POST',
      `/repos/${issue.repo}/issues`,
      { title: issue.title, body: issue.body, labels: issue.labels },
    );
    return { number: created.number, url: created.html_url, reused: false };
  }

  async openFindings(repo: string): Promise<OpenFinding[]> {
    const found: OpenFinding[] = [];
    // Five pages of 100 is far more open findings than anyone should have.
    for (let page = 1; page <= 5; page++) {
      const issues = await githubRequest<
        { number: number; html_url: string; body: string | null; pull_request?: unknown }[]
      >(
        await this.#request(repo),
        'GET',
        `/repos/${repo}/issues?state=open&labels=found-by-tester&per_page=100&page=${page}`,
      );
      for (const issue of issues) {
        const fingerprint = issue.pull_request ? null : parseFingerprint(issue.body ?? '');
        if (fingerprint) found.push({ number: issue.number, url: issue.html_url, fingerprint });
      }
      if (issues.length < 100) break;
    }
    return found;
  }

  /** An issue as the factory sees it, for starting a run by hand. */
  async issue(repo: string, issueNumber: number): Promise<ForgeIssue> {
    const issue = await githubRequest<{
      number: number;
      title: string;
      body: string | null;
      labels: ({ name?: string } | string)[];
      pull_request?: unknown;
      user?: { login?: string } | null;
    }>(await this.#request(repo), 'GET', `/repos/${repo}/issues/${issueNumber}`);
    if (issue.pull_request) {
      throw new ForgeError(`${repo}#${issueNumber} is a pull request, not an issue`, {
        status: 422,
        retryable: false,
      });
    }
    return {
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      ...(issue.user?.login ? { author: issue.user.login } : {}),
    };
  }

  async mergePullRequest(repo: string, pullNumber: number): Promise<void> {
    await githubRequest(await this.#request(repo), 'PUT', `/repos/${repo}/pulls/${pullNumber}/merge`, {
      merge_method: 'squash',
    });
  }

  async requestMerge(request: MergeRequest): Promise<{ number: number; url: string; merged: boolean }> {
    const pr = await this.#pullFor(request.repo, request.head);
    if (!pr) {
      // The outbox opens the pull request first; a retry finds it.
      throw new ForgeError(`no pull request for ${request.head} yet`, { retryable: true });
    }
    const found = { number: pr.number, url: pr.html_url };
    if (pr.merged_at) return { ...found, merged: true };
    if (pr.state === 'closed') {
      throw new ForgeError(`${request.repo}#${pr.number} was closed without merging`, { retryable: false });
    }

    const response = await githubRequest<{ errors?: { message: string }[] }>(
      await this.#request(request.repo),
      'POST',
      '/graphql',
      { query: ENABLE_AUTO_MERGE, variables: { id: pr.node_id } },
    );
    const problem = response.errors?.map((e) => e.message).join('; ');
    if (!problem) return { ...found, merged: false };

    // GitHub refuses auto-merge when the pull request can already merge. Merge
    // it now, but only once the checks have passed, whatever the branch rules say.
    if (/clean status/i.test(problem)) {
      const status = await this.pullRequestStatus(request.repo, request.head);
      if (status?.checks !== 'success') {
        throw new ForgeError(`${request.repo}#${pr.number}: waiting for checks before merging`, {
          retryable: true,
          retryAfterMs: 60_000,
        });
      }
      await this.mergePullRequest(request.repo, pr.number);
      return { ...found, merged: true };
    }
    throw new ForgeError(`could not enable auto-merge on ${request.repo}#${pr.number}: ${problem}`, {
      retryable: false,
    });
  }

  async pullRequestStatus(repo: string, head: string): Promise<PullRequestStatus | null> {
    const pr = await this.#pullFor(repo, head);
    if (!pr) return null;
    const { check_runs: runs } = await githubRequest<{
      check_runs: { name: string; status: string; conclusion: string | null }[];
    }>(await this.#request(repo), 'GET', `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`);
    const failing = runs
      .filter((r) => r.conclusion && FAILED_CONCLUSIONS.has(r.conclusion))
      .map((r) => r.name);
    const pending = runs.length === 0 || runs.some((r) => r.status !== 'completed');
    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.merged_at ? 'merged' : pr.state,
      mergeSha: pr.merged_at ? pr.merge_commit_sha : null,
      checks: failing.length > 0 ? 'failure' : pending ? 'pending' : 'success',
      failingChecks: failing,
    };
  }

  /**
   * Where the production deploy of `sha` stands. Hosts report it to GitHub
   * either as a deployment to `environment` or as a commit status named
   * `statusContext` (Vercel posts a "Vercel" status unless its GitHub
   * deployments are turned on); whichever the host uses is read.
   */
  async deploymentState(
    repo: string,
    sha: string,
    signal: { readonly environment: string; readonly statusContext: string },
  ): Promise<{ state: 'none' | 'pending' | 'success' | 'failure'; url: string | null }> {
    const request = await this.#request(repo);
    const deployments = await githubRequest<{ id: number }[]>(
      request,
      'GET',
      `/repos/${repo}/deployments?sha=${sha}&environment=${encodeURIComponent(signal.environment)}&per_page=5`,
    );
    const latest = deployments[0];
    if (latest) {
      const statuses = await githubRequest<{ state: string; environment_url?: string }[]>(
        request,
        'GET',
        `/repos/${repo}/deployments/${latest.id}/statuses?per_page=1`,
      );
      return toDeployState(statuses[0]?.state, statuses[0]?.environment_url);
    }
    // Newest first; the first status with the host's context is its current one.
    const statuses = await githubRequest<{ context: string; state: string; target_url?: string | null }[]>(
      request,
      'GET',
      `/repos/${repo}/commits/${sha}/statuses?per_page=100`,
    );
    const status = statuses.find((s) => s.context === signal.statusContext);
    return status ? toDeployState(status.state, status.target_url) : { state: 'none', url: null };
  }

  /**
   * Opens a pull request that reverts the merged one for `head`, then asks
   * GitHub to merge it like any other: once the required checks pass.
   */
  async revertPullRequest(input: RevertRequest): Promise<{ number: number; url: string; merged: boolean }> {
    const original = await this.#pullFor(input.repo, input.head);
    if (!original?.merged_at) {
      throw new ForgeError(`${input.repo} ${input.head} has no merged pull request to revert`, {
        retryable: false,
      });
    }
    // GitHub names the revert branch after the original pull request.
    const revertHead = `revert-${original.number}-${input.head}`;
    const existing = input.mayAlreadyExist ? await this.#pullFor(input.repo, revertHead) : null;
    if (!existing) {
      const response = await githubRequest<{ errors?: { message: string }[] }>(
        await this.#request(input.repo),
        'POST',
        '/graphql',
        {
          query: REVERT_PULL_REQUEST,
          variables: { id: original.node_id, title: input.title, body: input.body },
        },
      );
      const problem = response.errors?.map((e) => e.message).join('; ');
      if (problem) {
        throw new ForgeError(`could not revert ${input.repo}#${original.number}: ${problem}`, {
          retryable: false,
        });
      }
    }
    return this.requestMerge({ repo: input.repo, head: revertHead });
  }

  /** Swaps one label for another on an issue. Removing a label it does not have is fine. */
  async relabel(repo: string, issueNumber: number, remove: string, add: string): Promise<void> {
    const request = await this.#request(repo);
    try {
      await githubRequest(
        request,
        'DELETE',
        `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(remove)}`,
      );
    } catch (error) {
      if (!(error instanceof ForgeError && error.status === 404)) throw error;
    }
    await githubRequest(request, 'POST', `/repos/${repo}/issues/${issueNumber}/labels`, { labels: [add] });
  }

  /** Every open issue in the repository (not pull requests), for working through a backlog. */
  async openIssues(repo: string): Promise<ForgeIssue[]> {
    const found: ForgeIssue[] = [];
    for (let page = 1; page <= 10; page++) {
      const issues = await githubRequest<
        {
          number: number;
          title: string;
          body: string | null;
          labels: (string | { name?: string })[];
          pull_request?: unknown;
          user?: { login?: string } | null;
        }[]
      >(await this.#request(repo), 'GET', `/repos/${repo}/issues?state=open&per_page=100&page=${page}`);
      for (const issue of issues) {
        if (issue.pull_request) continue;
        found.push({
          repo,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
          ...(issue.user?.login ? { author: issue.user.login } : {}),
        });
      }
      if (issues.length < 100) break;
    }
    return found;
  }

  /** The most recent pull request for a factory branch, open or not. */
  async #pullFor(repo: string, head: string): Promise<PullRow | null> {
    const owner = repo.split('/')[0];
    const pulls = await githubRequest<PullRow[]>(
      await this.#request(repo),
      'GET',
      `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}`,
    );
    return pulls[0] ?? null;
  }

  async #request(repo: string) {
    return { fetch: this.#fetch, baseUrl: this.#baseUrl, token: await this.#auth.tokenFor(repo) };
  }
}

/**
 * Git access to target repositories as the factory's GitHub App: an HTTPS
 * URL with a short-lived installation token. Workers redact it from errors.
 */
export function gitHubRepoAccess(auth: Pick<GitHubAppAuth, 'tokenFor'>): {
  remoteUrl(repo: string): Promise<string>;
} {
  return {
    async remoteUrl(repo) {
      return `https://x-access-token:${await auth.tokenFor(repo)}@github.com/${repo}.git`;
    },
  };
}
