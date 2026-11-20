import { describe, expect, it } from 'vitest';
import { ForgeError, githubRequest } from './client.ts';
import { fakeGitHub, json } from './fake-github.ts';
import { dedupeMarker, GitHubForge } from './forge.ts';

const auth = { tokenFor: async () => 'installation-token' };
const COMMENTS = '/repos/codyalves/target/issues/42/comments';
const comment = {
  repo: 'codyalves/target',
  issueNumber: 42,
  body: 'Please add testable acceptance criteria.',
  dedupeKey: 'outbox-7',
};

describe('GitHubForge.comment', () => {
  it('posts the comment with a hidden dedupe marker, as the app installation', async () => {
    const github = fakeGitHub({
      [`POST ${COMMENTS}`]: () => json({ html_url: 'https://github.com/c/1' }, 201),
    });

    const result = await new GitHubForge({ auth, fetch: github.fetch }).comment({
      ...comment,
      mayAlreadyExist: false,
    });

    expect(result).toEqual({ url: 'https://github.com/c/1', reused: false });
    expect(github.requests).toMatchObject([
      {
        method: 'POST',
        authorization: 'Bearer installation-token',
        body: { body: `Please add testable acceptance criteria.\n\n${dedupeMarker('outbox-7')}` },
      },
    ]);
  });

  it('on a retry, finds the earlier comment instead of posting twice', async () => {
    const github = fakeGitHub({
      [`GET ${COMMENTS}?per_page=100&page=1`]: () =>
        json([
          { body: 'unrelated', html_url: 'x' },
          { body: `text\n\n${dedupeMarker('outbox-7')}`, html_url: 'found' },
        ]),
    });

    const result = await new GitHubForge({ auth, fetch: github.fetch }).comment({
      ...comment,
      mayAlreadyExist: true,
    });

    expect(result).toEqual({ url: 'found', reused: true });
    expect(github.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('on a retry with no earlier comment, posts it', async () => {
    const github = fakeGitHub({
      [`GET ${COMMENTS}?per_page=100&page=1`]: () => json([]),
      [`POST ${COMMENTS}`]: () => json({ html_url: 'new' }, 201),
    });

    const result = await new GitHubForge({ auth, fetch: github.fetch }).comment({
      ...comment,
      mayAlreadyExist: true,
    });

    expect(result).toEqual({ url: 'new', reused: false });
  });
});

describe('githubRequest errors', () => {
  const call = (response: () => Response, now = 0) =>
    githubRequest(
      {
        fetch: fakeGitHub({ 'GET /x': response }).fetch,
        baseUrl: 'https://api.test',
        token: 't',
        now: () => now,
      },
      'GET',
      '/x',
    ).catch((e: unknown) => e);

  it('marks server errors retryable and client errors not', async () => {
    expect(await call(() => json({}, 502))).toMatchObject({ status: 502, retryable: true });
    expect(await call(() => json({ message: 'Not Found' }, 404))).toMatchObject({
      status: 404,
      retryable: false,
    });
  });

  it('honors Retry-After on secondary rate limits', async () => {
    expect(await call(() => json({}, 403, { 'retry-after': '30' }))).toMatchObject({
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  it('waits for the reset when the primary rate limit is exhausted', async () => {
    const error = await call(
      () => json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' }),
      990_000,
    );

    expect(error).toMatchObject({ retryable: true, retryAfterMs: 10_000 });
  });

  it('treats a network failure as retryable', async () => {
    const error = await githubRequest(
      {
        fetch: async () => Promise.reject(new TypeError('fetch failed')),
        baseUrl: 'https://api.test',
        token: 't',
      },
      'GET',
      '/x',
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ retryable: true });
  });
});

describe('GitHubForge.openPullRequest', () => {
  const PULLS = '/repos/codyalves/target/pulls';
  const draft = {
    repo: 'codyalves/target',
    head: 'factory/7-abcd1234',
    base: 'main',
    title: 'Footer shows last year',
    body: 'Closes #7.',
  };
  const existing = `GET ${PULLS}?state=open&head=codyalves%3Afactory%2F7-abcd1234`;

  it('opens the pull request from the factory branch', async () => {
    const github = fakeGitHub({ [`POST ${PULLS}`]: () => json({ number: 12, html_url: 'pr-12' }, 201) });

    const result = await new GitHubForge({ auth, fetch: github.fetch }).openPullRequest({
      ...draft,
      mayAlreadyExist: false,
    });

    expect(result).toEqual({ number: 12, url: 'pr-12', reused: false });
    expect(github.requests[0]?.body).toEqual({
      title: draft.title,
      head: draft.head,
      base: 'main',
      body: 'Closes #7.',
    });
  });

  it('on a retry, returns the pull request an earlier attempt opened', async () => {
    const github = fakeGitHub({ [existing]: () => json([{ number: 12, html_url: 'pr-12' }]) });

    const result = await new GitHubForge({ auth, fetch: github.fetch }).openPullRequest({
      ...draft,
      mayAlreadyExist: true,
    });

    expect(result).toEqual({ number: 12, url: 'pr-12', reused: true });
    expect(github.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('treats "already exists" as success when the pull request is found', async () => {
    const github = fakeGitHub({
      [`POST ${PULLS}`]: () => json({ message: 'A pull request already exists' }, 422),
      [existing]: () => json([{ number: 12, html_url: 'pr-12' }]),
    });

    const result = await new GitHubForge({ auth, fetch: github.fetch }).openPullRequest({
      ...draft,
      mayAlreadyExist: false,
    });

    expect(result).toEqual({ number: 12, url: 'pr-12', reused: true });
  });
});

describe('GitHubForge.issue', () => {
  it('reads an issue for a manual run', async () => {
    const github = fakeGitHub({
      'GET /repos/codyalves/target/issues/7': () =>
        json({ number: 7, title: 'Footer', body: null, labels: [{ name: 'factory' }, 'bug'] }),
    });

    const issue = await new GitHubForge({ auth, fetch: github.fetch }).issue('codyalves/target', 7);

    expect(issue).toEqual({
      repo: 'codyalves/target',
      number: 7,
      title: 'Footer',
      body: '',
      labels: ['factory', 'bug'],
    });
  });

  it('refuses a pull request', async () => {
    const github = fakeGitHub({
      'GET /repos/codyalves/target/issues/8': () =>
        json({ number: 8, title: 'x', body: '', labels: [], pull_request: {} }),
    });

    await expect(new GitHubForge({ auth, fetch: github.fetch }).issue('codyalves/target', 8)).rejects.toThrow(
      /is a pull request/,
    );
  });
});

describe('GitHubForge findings', () => {
  const FP = '0123456789abcdef';
  const body = `text\n<!-- software-factory:finding fingerprint=${FP} -->`;
  const list = 'GET /repos/codyalves/target/issues?state=open&labels=found-by-tester&per_page=100&page=1';
  const draft = {
    repo: 'codyalves/target',
    title: 'Broken link on /pricing',
    body,
    labels: ['found-by-tester'],
    fingerprint: FP,
  };

  it('lists open findings by fingerprint, skipping pull requests and unmarked issues', async () => {
    const github = fakeGitHub({
      [list]: () =>
        json([
          { number: 4, html_url: 'issue-4', body },
          { number: 5, html_url: 'issue-5', body: 'no marker' },
          { number: 6, html_url: 'pr-6', body, pull_request: {} },
        ]),
    });

    expect(await new GitHubForge({ auth, fetch: github.fetch }).openFindings('codyalves/target')).toEqual([
      { number: 4, url: 'issue-4', fingerprint: FP },
    ]);
  });

  it('files a finding as an issue with its labels', async () => {
    const github = fakeGitHub({
      'POST /repos/codyalves/target/issues': () => json({ number: 9, html_url: 'issue-9' }, 201),
    });

    const created = await new GitHubForge({ auth, fetch: github.fetch }).createIssue({
      ...draft,
      mayAlreadyExist: false,
    });

    expect(created).toEqual({ number: 9, url: 'issue-9', reused: false });
    expect(github.requests[0]?.body).toEqual({ title: draft.title, body, labels: ['found-by-tester'] });
  });

  it('on a retry, returns the issue an earlier attempt filed instead of filing twice', async () => {
    const github = fakeGitHub({ [list]: () => json([{ number: 4, html_url: 'issue-4', body }]) });

    const created = await new GitHubForge({ auth, fetch: github.fetch }).createIssue({
      ...draft,
      mayAlreadyExist: true,
    });

    expect(created).toEqual({ number: 4, url: 'issue-4', reused: true });
    expect(github.requests.map((r) => r.method)).toEqual(['GET']);
  });
});

describe('GitHubForge merging', () => {
  const repo = 'codyalves/target';
  const PULLS = `/repos/${repo}/pulls?state=all&head=${encodeURIComponent('codyalves:factory/9-abc')}`;
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 12,
    node_id: 'PR_node',
    html_url: 'https://github.com/codyalves/target/pull/12',
    state: 'open',
    merged_at: null,
    merge_commit_sha: null,
    head: { sha: 'f00d' },
    ...over,
  });
  const CHECKS = `/repos/${repo}/commits/f00d/check-runs?per_page=100`;
  const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
  const forgeFor = (github: ReturnType<typeof fakeGitHub>) => new GitHubForge({ auth, fetch: github.fetch });

  it('turns on auto-merge, so GitHub merges once the required checks pass', async () => {
    const github = fakeGitHub({
      [`GET ${PULLS}`]: () => json([pull()]),
      'POST /graphql': () => json({ data: { enablePullRequestAutoMerge: { clientMutationId: null } } }),
    });

    const result = await forgeFor(github).requestMerge({ repo, head: 'factory/9-abc' });

    expect(result).toEqual({ number: 12, url: pull().html_url, merged: false });
    expect(github.requests[1]?.body).toMatchObject({ variables: { id: 'PR_node' } });
  });

  it('merges straight away when the pull request is already clean and its checks passed', async () => {
    const github = fakeGitHub({
      [`GET ${PULLS}`]: () => json([pull()]),
      'POST /graphql': () => json({ errors: [{ message: 'Pull request is in clean status' }] }),
      [`GET ${CHECKS}`]: () => json({ check_runs: [run('ci', 'completed', 'success')] }),
      [`PUT /repos/${repo}/pulls/12/merge`]: () => json({ merged: true }),
    });

    expect(await forgeFor(github).requestMerge({ repo, head: 'factory/9-abc' })).toMatchObject({
      merged: true,
    });
  });

  it('never merges a clean pull request whose checks have not passed', async () => {
    const github = fakeGitHub({
      [`GET ${PULLS}`]: () => json([pull()]),
      'POST /graphql': () => json({ errors: [{ message: 'Pull request is in clean status' }] }),
      [`GET ${CHECKS}`]: () => json({ check_runs: [run('ci', 'in_progress', null)] }),
    });

    const error = await forgeFor(github)
      .requestMerge({ repo, head: 'factory/9-abc' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).retryable).toBe(true);
    expect(github.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('asks the outbox to retry when the pull request is not open yet', async () => {
    const github = fakeGitHub({ [`GET ${PULLS}`]: () => json([]) });

    const error = await forgeFor(github)
      .requestMerge({ repo, head: 'factory/9-abc' })
      .catch((e: unknown) => e);

    expect((error as ForgeError).retryable).toBe(true);
  });

  it('reports a merged pull request with its merge commit', async () => {
    const github = fakeGitHub({
      [`GET ${PULLS}`]: () =>
        json([pull({ state: 'closed', merged_at: '2026-11-20T12:00:00Z', merge_commit_sha: 'beef' })]),
      [`GET ${CHECKS}`]: () => json({ check_runs: [run('ci', 'completed', 'success')] }),
    });

    expect(await forgeFor(github).pullRequestStatus(repo, 'factory/9-abc')).toMatchObject({
      state: 'merged',
      mergeSha: 'beef',
      checks: 'success',
    });
  });

  it('reports pending until every check finishes, and names the failing ones', async () => {
    const pending = fakeGitHub({
      [`GET ${PULLS}`]: () => json([pull()]),
      [`GET ${CHECKS}`]: () =>
        json({ check_runs: [run('lint', 'completed', 'success'), run('e2e', 'queued', null)] }),
    });
    const failing = fakeGitHub({
      [`GET ${PULLS}`]: () => json([pull()]),
      [`GET ${CHECKS}`]: () =>
        json({ check_runs: [run('lint', 'completed', 'success'), run('e2e', 'completed', 'failure')] }),
    });

    expect(await forgeFor(pending).pullRequestStatus(repo, 'factory/9-abc')).toMatchObject({
      checks: 'pending',
    });
    expect(await forgeFor(failing).pullRequestStatus(repo, 'factory/9-abc')).toMatchObject({
      checks: 'failure',
      failingChecks: ['e2e'],
    });
  });
});

describe('GitHubForge.openIssues', () => {
  it('lists open issues with their labels, leaving out pull requests', async () => {
    const github = fakeGitHub({
      'GET /repos/codyalves/target/issues?state=open&per_page=100&page=1': () =>
        json([
          { number: 8, title: 'Chat box', body: 'Depends on #7', labels: [{ name: 'factory:ready' }] },
          { number: 9, title: 'A PR', body: '', labels: [], pull_request: {} },
          { number: 10, title: 'Idea', body: null, labels: ['someday'], user: { login: 'codyalves' } },
        ]),
    });

    const issues = await new GitHubForge({ auth, fetch: github.fetch }).openIssues('codyalves/target');

    expect(issues).toEqual([
      {
        repo: 'codyalves/target',
        number: 8,
        title: 'Chat box',
        body: 'Depends on #7',
        labels: ['factory:ready'],
      },
      {
        repo: 'codyalves/target',
        number: 10,
        title: 'Idea',
        body: '',
        labels: ['someday'],
        author: 'codyalves',
      },
    ]);
  });
});
