import { createHash, timingSafeEqual } from 'node:crypto';
import type { StepQueue } from '@factory/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface AdminDependencies {
  readonly steps: Pick<StepQueue, 'listDeadLetters' | 'replay'>;
  /** Unset disables every admin route. */
  readonly adminToken: string | undefined;
}

const stepParams = z.object({ id: z.uuid() });
const replayBody = z.object({
  /** Recorded in the audit log. Self-declared until per-user auth exists (M2). */
  actor: z.string().trim().min(1).max(100),
});
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/**
 * Operator routes under /admin: inspect the dead-letter queue and replay a
 * step. Every route requires `Authorization: Bearer <ADMIN_TOKEN>`.
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
