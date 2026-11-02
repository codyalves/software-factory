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
