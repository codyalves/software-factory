import { AuditStore, enqueueOutbox, OutboxRelay, RunStore } from '@factory/db';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '@factory/db/testing';
import { ForgeError, GitHubForge } from '@factory/github';
import { fakeGitHub, json } from '@factory/github/testing';
import { describe, expect, it } from 'vitest';
import { classifyDelivery, deliverNextOutbox } from './outbox.ts';

const COMMENTS = '/repos/codyalves/target/issues/42/comments';
const auth = { tokenFor: async () => 'installation-token' };
/** No backoff, so a retried message is due again immediately. */
const instant = { policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } };

/** A GitHub issue thread that stores comments, and can fail a POST after storing it. */
function issueThread(options: { failAfterStoring?: number } = {}) {
  const stored: { body: string; html_url: string }[] = [];
  let posts = 0;
  const github = fakeGitHub({
    [`GET ${COMMENTS}?per_page=100&page=1`]: () => json(stored),
    [`POST ${COMMENTS}`]: (request) => {
      posts++;
      const comment = { body: (request.body as { body: string }).body, html_url: `https://gh/c/${posts}` };
      stored.push(comment);
      return posts === options.failAfterStoring ? json({ message: 'Bad Gateway' }, 502) : json(comment, 201);
    },
  });
  return { github, stored, forge: new GitHubForge({ auth, fetch: github.fetch }) };
}

async function queueComment(t: TestDatabase, payload: unknown = {}): Promise<void> {
  const created = await new RunStore(t.db).createFromIssue(
    { repo: 'codyalves/target', number: 42, title: 't', body: '', labels: ['factory'] },
    'github',
    'd-1',
  );
  if (created.outcome !== 'created') throw new Error('expected a run');
  await enqueueOutbox(t.db, created.runId, 'issue.comment', {
    repo: 'codyalves/target',
    issueNumber: 42,
    body: 'Please add testable acceptance criteria.',
    ...(payload as object),
  });
}

const outboxRow = async (t: TestDatabase) =>
  (await t.pool.query('select attempts, sent_at, failed_at, last_error, result from outbox')).rows[0];

describe('classifyDelivery', () => {
  it('retries what GitHub says is retryable, with its delay', () => {
    expect(
      classifyDelivery(new ForgeError('rate limited', { status: 403, retryable: true, retryAfterMs: 9_000 })),
    ).toEqual({
      failureClass: 'transient',
      message: 'rate limited',
      retryAfterMs: 9_000,
    });
    expect(classifyDelivery(new ForgeError('not found', { status: 404, retryable: false }))).toMatchObject({
      failureClass: 'permanent',
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('outbox relay', () => {
  it('holds messages while the factory is paused', async () => {
    await using t = await createTestDatabase();
    await queueComment(t);
    const thread = issueThread();
    const relay = new OutboxRelay(t.db, instant);

    expect(await deliverNextOutbox(relay, thread.forge, async () => ({ ok: false }))).toBeNull();
    expect(thread.stored).toHaveLength(0);
    expect(await deliverNextOutbox(relay, thread.forge, async () => ({ ok: true }))).toMatch(/sent$/);
    expect(thread.stored).toHaveLength(1);
  });

  it('posts a queued comment once and records it', async () => {
    await using t = await createTestDatabase();
    await queueComment(t);
    const thread = issueThread();
    const relay = new OutboxRelay(t.db, instant);

    expect(await deliverNextOutbox(relay, thread.forge)).toMatch(/sent$/);
    expect(await deliverNextOutbox(relay, thread.forge)).toBeNull();

    expect(thread.stored).toHaveLength(1);
    expect(await outboxRow(t)).toMatchObject({
      attempts: 0,
      failed_at: null,
      result: { url: 'https://gh/c/1', reused: false },
    });
    expect((await new AuditStore(t.db).readAll()).at(-1)?.type).toBe('outbox.sent');
  });

  it('does not post twice when GitHub stored the comment but the response was lost', async () => {
    await using t = await createTestDatabase();
    await queueComment(t);
    const thread = issueThread({ failAfterStoring: 1 });
    const relay = new OutboxRelay(t.db, instant);

    expect(await deliverNextOutbox(relay, thread.forge)).toMatch(/retry_scheduled/);
    expect(await deliverNextOutbox(relay, thread.forge)).toMatch(/sent$/);

    expect(thread.stored).toHaveLength(1);
    expect(await outboxRow(t)).toMatchObject({ attempts: 1, result: { reused: true } });
    const types = (await new AuditStore(t.db).readAll()).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['outbox.retry_scheduled', 'outbox.sent']);
  });

  it('gives up on a permanent failure and records why', async () => {
    await using t = await createTestDatabase();
    await queueComment(t);
    const github = fakeGitHub({ [`POST ${COMMENTS}`]: () => json({ message: 'Not Found' }, 404) });
    const relay = new OutboxRelay(t.db, instant);

    expect(await deliverNextOutbox(relay, new GitHubForge({ auth, fetch: github.fetch }))).toMatch(/failed/);
    expect(await deliverNextOutbox(relay, new GitHubForge({ auth, fetch: github.fetch }))).toBeNull();

    const row = await outboxRow(t);
    expect(row.failed_at).not.toBeNull();
    expect(row.last_error).toContain('404');
    expect((await new AuditStore(t.db).readAll()).at(-1)?.type).toBe('outbox.failed');
  });

  it('stops retrying after the attempt limit', async () => {
    await using t = await createTestDatabase();
    await queueComment(t);
    const github = fakeGitHub({
      [`GET ${COMMENTS}?per_page=100&page=1`]: () => json([]),
      [`POST ${COMMENTS}`]: () => json({}, 503),
    });
    const forge = new GitHubForge({ auth, fetch: github.fetch });
    const relay = new OutboxRelay(t.db, instant);

    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await deliverNextOutbox(relay, forge));

    expect(outcomes.map((o) => o?.match(/\) (\w+)/)?.[1] ?? null)).toEqual([
      'retry_scheduled',
      'retry_scheduled',
      'failed',
      null,
    ]);
  });

  it('opens a queued pull request through the forge', async () => {
    await using t = await createTestDatabase();
    const created = await new RunStore(t.db).createFromIssue(
      { repo: 'codyalves/target', number: 7, title: 't', body: '', labels: ['factory'] },
      'github',
      'd-pr',
    );
    if (created.outcome !== 'created') throw new Error('expected a run');
    await enqueueOutbox(t.db, created.runId, 'pull_request.open', {
      repo: 'codyalves/target',
      head: 'factory/7-abcd1234',
      base: 'main',
      title: 'Footer shows last year',
      body: 'Closes #7.',
    });
    const opened: unknown[] = [];
    const forge = {
      name: 'fake',
      comment: async () => ({ url: '', reused: false }),
      openPullRequest: async (pr: unknown) => {
        opened.push(pr);
        return { number: 12, url: 'pr-12', reused: false };
      },
      mergePullRequest: async () => {},
    };

    expect(await deliverNextOutbox(new OutboxRelay(t.db, instant), forge)).toMatch(
      /pull_request.open\) sent$/,
    );
    expect(opened).toEqual([
      {
        repo: 'codyalves/target',
        head: 'factory/7-abcd1234',
        base: 'main',
        title: 'Footer shows last year',
        body: 'Closes #7.',
        mayAlreadyExist: false,
      },
    ]);
  });

  it('fails a malformed message without calling GitHub', async () => {
    await using t = await createTestDatabase();
    await queueComment(t, { issueNumber: 'not a number' });
    const thread = issueThread();

    expect(await deliverNextOutbox(new OutboxRelay(t.db, instant), thread.forge)).toMatch(/failed/);
    expect(thread.github.requests).toEqual([]);
  });
});
