import { createHmac } from 'node:crypto';
import { AuditStore, FactoryControl, RunStore, StepQueue } from '@factory/db';
import { createTestDatabase, TEST_DATABASE_URL } from '@factory/db/testing';
import { describe, expect, it, vi } from 'vitest';
import { type AppDependencies, buildApp } from './app.ts';

const SECRET = 'test-secret';
const ADMIN_TOKEN = 'a'.repeat(40);
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
const STEP_ID = '0b8c2a8e-3f7b-4c55-9a43-1d2e3f4a5b6c';

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
    steps: {
      listDeadLetters: vi.fn().mockResolvedValue([]),
      replay: vi.fn().mockResolvedValue(true),
    },
    control: {
      status: vi.fn().mockResolvedValue({ paused: true }),
      pause: vi.fn().mockResolvedValue({ paused: true }),
      resume: vi.fn().mockResolvedValue({ paused: false }),
      setBudget: vi.fn().mockResolvedValue({ paused: true }),
    },
    adminToken: ADMIN_TOKEN,
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

describe('admin routes', () => {
  it('require the admin token', async () => {
    const app = buildApp(fakeDeps());

    const missing = await app.inject({ method: 'GET', url: '/admin/dead-letters' });
    const wrong = await app.inject({
      method: 'GET',
      url: '/admin/dead-letters',
      headers: { authorization: `Bearer ${'b'.repeat(40)}` },
    });
    const right = await app.inject({ method: 'GET', url: '/admin/dead-letters', headers: admin });

    expect([missing.statusCode, wrong.statusCode, right.statusCode]).toEqual([401, 401, 200]);
  });

  it('are disabled when no admin token is configured', async () => {
    const response = await buildApp({ ...fakeDeps(), adminToken: undefined }).inject({
      method: 'GET',
      url: '/admin/dead-letters',
      headers: admin,
    });

    expect(response.statusCode).toBe(503);
  });

  it('replay a dead-lettered step on behalf of the named actor', async () => {
    const deps = fakeDeps();

    const response = await buildApp(deps).inject({
      method: 'POST',
      url: `/admin/steps/${STEP_ID}/replay`,
      headers: admin,
      payload: { actor: 'codyalves' },
    });

    expect(response.statusCode).toBe(202);
    expect(deps.steps.replay).toHaveBeenCalledWith(STEP_ID, 'codyalves');
  });

  it('pause and resume on behalf of the named actor', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);

    const paused = await app.inject({
      method: 'POST',
      url: '/admin/pause',
      headers: admin,
      payload: { actor: 'codyalves', reason: 'done for the day' },
    });
    const resumed = await app.inject({
      method: 'POST',
      url: '/admin/resume',
      headers: admin,
      payload: { actor: 'codyalves' },
    });

    expect([paused.statusCode, resumed.statusCode]).toEqual([200, 200]);
    expect(deps.control.pause).toHaveBeenCalledWith('codyalves', 'done for the day');
    expect(deps.control.resume).toHaveBeenCalledWith('codyalves');
  });

  it('refuse a pause without a reason', async () => {
    const response = await buildApp(fakeDeps()).inject({
      method: 'POST',
      url: '/admin/pause',
      headers: admin,
      payload: { actor: 'codyalves' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('validate the budget and its time zone', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/admin/budget', headers: admin, payload });

    const ok = await put({ actor: 'codyalves', dailyBudgetUsd: 2.5, timeZone: 'America/New_York' });
    const badZone = await put({ actor: 'codyalves', dailyBudgetUsd: 2.5, timeZone: 'Mars/Olympus' });
    const negative = await put({ actor: 'codyalves', dailyBudgetUsd: -1 });

    expect([ok.statusCode, badZone.statusCode, negative.statusCode]).toEqual([200, 400, 400]);
    expect(deps.control.setBudget).toHaveBeenCalledWith('codyalves', 2.5, 'America/New_York');
  });

  it('refuse a replay without an actor', async () => {
    const response = await buildApp(fakeDeps()).inject({
      method: 'POST',
      url: `/admin/steps/${STEP_ID}/replay`,
      headers: admin,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('API with Postgres', () => {
  it('turns a signed issue webhook into a run with a valid audit chain', async () => {
    await using t = await createTestDatabase();
    const app = buildApp({
      runs: new RunStore(t.db),
      audit: new AuditStore(t.db),
      steps: new StepQueue(t.db),
      control: new FactoryControl(t.db),
      webhookSecret: SECRET,
    });

    const created = await app.inject(signedWebhook(openedIssue));
    const redelivered = await app.inject(signedWebhook(openedIssue));

    expect(created.statusCode).toBe(202);
    expect(redelivered.json()).toEqual({ outcome: 'duplicate-delivery' });

    const run = await app.inject({ method: 'GET', url: created.headers.location as string });
    expect(run.json()).toMatchObject({ state: 'Intake' });

    const verify = await app.inject({ method: 'GET', url: '/audit/verify' });
    expect(verify.json()).toMatchObject({ valid: true, events: 2, database: [] });
  });

  it('lists a dead letter and replays it through the admin API', async () => {
    await using t = await createTestDatabase();
    const steps = new StepQueue(t.db, { policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
    const app = buildApp({
      runs: new RunStore(t.db),
      audit: new AuditStore(t.db),
      steps,
      control: new FactoryControl(t.db),
      webhookSecret: SECRET,
      adminToken: ADMIN_TOKEN,
    });
    const created = await app.inject(signedWebhook(openedIssue));
    const { stepId } = await steps.enqueue({
      runId: created.json().runId,
      kind: 'triage',
      idempotencyKey: 'triage',
    });
    await steps.claim('w', ['triage'], 30_000);
    await steps.fail(stepId, 'w', { failureClass: 'permanent', message: 'bad prompt version' });

    const list = await app.inject({ method: 'GET', url: '/admin/dead-letters', headers: admin });
    expect(list.json().deadLetters).toMatchObject([
      { step: { id: stepId }, lastError: 'bad prompt version' },
    ]);

    const replay = await app.inject({
      method: 'POST',
      url: `/admin/steps/${stepId}/replay`,
      headers: admin,
      payload: { actor: 'codyalves' },
    });
    const again = await app.inject({
      method: 'POST',
      url: `/admin/steps/${stepId}/replay`,
      headers: admin,
      payload: { actor: 'codyalves' },
    });

    expect([replay.statusCode, again.statusCode]).toEqual([202, 409]);
  });

  it('starts paused, resumes through the admin API, and audits the change', async () => {
    await using t = await createTestDatabase();
    const app = buildApp({
      runs: new RunStore(t.db),
      audit: new AuditStore(t.db),
      steps: new StepQueue(t.db),
      control: new FactoryControl(t.db),
      webhookSecret: SECRET,
      adminToken: ADMIN_TOKEN,
    });

    const before = await app.inject({ method: 'GET', url: '/admin/status', headers: admin });
    const resumed = await app.inject({
      method: 'POST',
      url: '/admin/resume',
      headers: admin,
      payload: { actor: 'codyalves' },
    });

    expect(before.json()).toMatchObject({ paused: true, dailyBudgetUsd: 3, spentTodayUsd: 0 });
    expect(resumed.json()).toMatchObject({ paused: false, changedBy: 'codyalves' });
    const events = await new AuditStore(t.db).readAll();
    expect(events.map((e) => e.type)).toEqual(['factory.resumed']);
    expect(await new AuditStore(t.db).verifyInDatabase()).toEqual([]);
  });
});
