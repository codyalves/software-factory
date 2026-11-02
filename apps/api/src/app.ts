import type { AuditStore, FactoryControl, IntakeResult, RunStore, StepQueue } from '@factory/db';
import { isSignatureValid, parseIssueEvent } from '@factory/github';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { adminRoutes } from './admin.ts';

export interface AppDependencies {
  readonly runs: Pick<RunStore, 'createFromIssue' | 'get'>;
  readonly audit: Pick<AuditStore, 'verify' | 'verifyInDatabase'>;
  readonly steps: Pick<StepQueue, 'listDeadLetters' | 'replay'>;
  readonly control: Pick<FactoryControl, 'status' | 'pause' | 'resume' | 'setBudget'>;
  readonly webhookSecret: string;
  readonly adminToken?: string | undefined;
}

/** GitHub caps webhook payloads at 25 MB. */
const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;

const runParams = z.object({ id: z.uuid() });

export function buildApp(deps: AppDependencies, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get('/healthz', async () => ({ status: 'ok' }));

  // GitHub calls this for repository events. Only signed "issues" events that
  // carry the factory label start a run. The signature covers the raw bytes,
  // so this route keeps the body as a Buffer instead of parsing it.
  app.register(async (webhooks) => {
    webhooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    webhooks.post('/webhooks/github', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signature = header(request.headers['x-hub-signature-256']);

      if (!isSignatureValid(deps.webhookSecret, body, signature)) {
        return reply.code(401).send({ error: 'invalid signature' });
      }

      const deliveryId = header(request.headers['x-github-delivery']);
      if (!deliveryId) {
        return reply.code(400).send({ error: 'missing X-GitHub-Delivery' });
      }

      const issue = parseIssueEvent(header(request.headers['x-github-event']), body);
      if (!issue) {
        return { ignored: true };
      }

      const result: IntakeResult = await deps.runs.createFromIssue(issue, 'github', deliveryId);
      if (result.outcome === 'created') {
        return reply.code(202).header('location', `/runs/${result.runId}`).send({ runId: result.runId });
      }
      return { outcome: result.outcome };
    });
  });

  app.register(adminRoutes, {
    prefix: '/admin',
    steps: deps.steps,
    control: deps.control,
    adminToken: deps.adminToken,
  });

  app.get('/runs/:id', async (request, reply) => {
    const params = runParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'run id must be a UUID' });
    }
    const run = await deps.runs.get(params.data.id);
    return run ?? reply.code(404).send({ error: 'run not found' });
  });

  // Recomputes the whole chain twice: once in Postgres, once in application code.
  app.get('/audit/verify', async () => {
    const [inApp, inDatabase] = await Promise.all([deps.audit.verify(), deps.audit.verifyInDatabase()]);
    return {
      valid: inApp.valid && inDatabase.length === 0,
      events: inApp.eventCount,
      headHash: inApp.headHash,
      application: inApp,
      database: inDatabase,
    };
  });

  return app;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
