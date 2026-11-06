import type { ForgeAdapter, IssueComment, PullRequestDraft } from '@factory/domain';
import type { GitHubAppAuth } from './app-auth.ts';
import { type Fetch, ForgeError, githubRequest } from './client.ts';

/** Hidden in every comment the factory posts, so a retry can recognize its own earlier post. */
export function dedupeMarker(key: string): string {
  return `<!-- software-factory:${key} -->`;
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

  async mergePullRequest(repo: string, pullNumber: number): Promise<void> {
    await githubRequest(await this.#request(repo), 'PUT', `/repos/${repo}/pulls/${pullNumber}/merge`, {
      merge_method: 'squash',
    });
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
