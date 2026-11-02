import { createHmac } from 'node:crypto';
import { AuditStore, RunStore } from '@factory/db';
import { createTestDatabase, TEST_DATABASE_URL } from '@factory/db/testing';
import { describe, expect, it, vi } from 'vitest';
import { type AppDependencies, buildApp } from './app.ts';

const SECRET = 'test-secret';

function signedWebhook(payload: unknown, deliveryId = 'delivery-1', event = 'issues') {
  const body = JSON.stringify(payload);
  return {
    method: 'POST' as const,
    url: '/webhooks/github',
    body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
  };
}

const openedIssue = {
  action: 'opened',
  issue: {
    number: 7,
    title: 'Add a contact page',
    body: 'Visitors can reach us.',
    labels: [{ name: 'factory' }],
  },
  repository: { full_name: 'codyalves/factory-target-app' },
};

function fakeDeps(): AppDependencies {
  return {
    webhookSecret: SECRET,
    runs: {
      createFromIssue: vi.fn().mockResolvedValue({ outcome: 'created', runId: 'r1' }),
      get: vi.fn().mockResolvedValue(null),
    },
    audit: {
      verify: vi.fn().mockResolvedValue({ valid: true, eventCount: 0, headHash: '0'.repeat(64) }),
      verifyInDatabase: vi.fn().mockResolvedValue([]),
    },
  };
}

describe('API', () => {
  it('reports health', async () => {
    const response = await buildApp(fakeDeps()).inject({ method: 'GET', url: '/healthz' });

    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('rejects a webhook with a bad signature before touching the database', async () => {
    const deps = fakeDeps();
    const request = signedWebhook(openedIssue);
    request.headers['x-hub-signature-256'] = `sha256=${'0'.repeat(64)}`;

    const response = await buildApp(deps).inject(request);

    expect(response.statusCode).toBe(401);
    expect(deps.runs.createFromIssue).not.toHaveBeenCalled();
  });

  it('acknowledges events that do not start a run', async () => {
    const response = await buildApp(fakeDeps()).inject(signedWebhook({}, 'd-1', 'push'));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ignored: true });
  });

  it('rejects a malformed run id', async () => {
    const response = await buildApp(fakeDeps()).inject({ method: 'GET', url: '/runs/not-a-uuid' });

    expect(response.statusCode).toBe(400);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('API with Postgres', () => {
  it('turns a signed issue webhook into a run with a valid audit chain', async () => {
    await using t = await createTestDatabase();
    const app = buildApp({ runs: new RunStore(t.db), audit: new AuditStore(t.db), webhookSecret: SECRET });

    const created = await app.inject(signedWebhook(openedIssue));
    const redelivered = await app.inject(signedWebhook(openedIssue));

    expect(created.statusCode).toBe(202);
    expect(redelivered.json()).toEqual({ outcome: 'duplicate-delivery' });

    const run = await app.inject({ method: 'GET', url: created.headers.location as string });
    expect(run.json()).toMatchObject({ state: 'Intake' });

    const verify = await app.inject({ method: 'GET', url: '/audit/verify' });
    expect(verify.json()).toMatchObject({ valid: true, events: 2, database: [] });
  });
});
