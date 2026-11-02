import { createHash, timingSafeEqual } from 'node:crypto';
import { assertTimeZone, type FactoryControl, type StepQueue } from '@factory/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface AdminDependencies {
  readonly steps: Pick<StepQueue, 'listDeadLetters' | 'replay'>;
  readonly control: Pick<FactoryControl, 'status' | 'pause' | 'resume' | 'setBudget'>;
  /** Unset disables every admin route. */
  readonly adminToken: string | undefined;
}

const stepParams = z.object({ id: z.uuid() });
const replayBody = z.object({
  /** Recorded in the audit log. Self-declared until per-user auth exists (M2). */
  actor: z.string().trim().min(1).max(100),
});
const actor = z.string().trim().min(1).max(100);
const pauseBody = z.object({ actor, reason: z.string().trim().min(1).max(500) });
const resumeBody = z.object({ actor });
const budgetBody = z.object({
  actor,
  dailyBudgetUsd: z.number().min(0).max(1000),
  timeZone: z
    .string()
    .refine((tz) => {
      try {
        assertTimeZone(tz);
        return true;
      } catch {
        return false;
      }
    }, 'unknown time zone')
    .optional(),
});
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/**
 * Operator routes under /admin: the pause switch and daily budget, the
 * dead-letter queue and step replay. Every route requires `Authorization: Bearer <ADMIN_TOKEN>`.
 */
export async function adminRoutes(app: FastifyInstance, deps: AdminDependencies): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!deps.adminToken) {
      return reply.code(503).send({ error: 'admin routes are disabled (ADMIN_TOKEN not set)' });
    }
    if (!tokenMatches(request.headers.authorization, deps.adminToken)) {
      return reply.code(401).send({ error: 'invalid admin token' });
    }
  });

  app.get('/status', async () => deps.control.status());

  app.post('/pause', async (request, reply) => {
    const body = pauseBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'expected a JSON body with "actor" and "reason"' });
    }
    return deps.control.pause(body.data.actor, body.data.reason);
  });

  app.post('/resume', async (request, reply) => {
    const body = resumeBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'expected a JSON body with "actor"' });
    }
    return deps.control.resume(body.data.actor);
  });

  app.put('/budget', async (request, reply) => {
    const body = budgetBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'expected "actor", "dailyBudgetUsd" (0-1000) and optionally an IANA "timeZone"',
      });
    }
    return deps.control.setBudget(body.data.actor, body.data.dailyBudgetUsd, body.data.timeZone);
  });

  app.get('/dead-letters', async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'limit must be 1-200' });
    }
    return { deadLetters: await deps.steps.listDeadLetters(query.data.limit) };
  });

  app.post('/steps/:id/replay', async (request, reply) => {
    const params = stepParams.safeParse(request.params);
    const body = replayBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'expected a step UUID and a JSON body with "actor"' });
    }
    if (!(await deps.steps.replay(params.data.id, body.data.actor))) {
      return reply.code(409).send({ error: 'step is not dead-lettered' });
    }
    return reply.code(202).send({ replayed: params.data.id });
  });
}

/** Constant-time comparison; hashing first makes the lengths equal. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(token));
}
