import {
  DEFAULT_RETRY_POLICY,
  decideRetry,
  type FailureClass,
  type ModelUsage,
  type RetryDecision,
  type RetryPolicy,
} from '@factory/domain';
import { type Kysely, sql, type Transaction } from 'kysely';
import { appendAuditEvent } from './audit-store.ts';
import type { Database, StepStatus } from './database.ts';

export interface Step {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly status: StepStatus;
  /** Attempts started so far, including the current one while running. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly leaseOwner: string | null;
}

export interface EnqueueInput {
  readonly runId: string;
  readonly kind: string;
  /** Same key, same step: enqueueing twice is a no-op. */
  readonly idempotencyKey: string;
  readonly payload?: unknown;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly delayMs?: number;
}

export interface StepFailure {
  readonly failureClass: FailureClass;
  readonly message: string;
  readonly details?: unknown;
  /** Server-provided Retry-After, if any. */
  readonly retryAfterMs?: number;
}

export interface DeadLetter {
  readonly step: Step;
  readonly failureClass: FailureClass | null;
  readonly lastError: string | null;
  readonly finishedAt: Date | null;
  readonly attempts: readonly {
    attempt: number;
    worker: string;
    outcome: string | null;
    failureClass: FailureClass | null;
    error: unknown;
  }[];
}

/** Audit payloads carry a short error summary; full details live in step_attempt. */
const MAX_AUDITED_ERROR = 500;

type Executor = Kysely<Database> | Transaction<Database>;

type StepRow = {
  id: string;
  run_id: string;
  kind: string;
  status: StepStatus;
  attempt: number;
  max_attempts: number;
  timeout_ms: number;
  payload: unknown;
  idempotency_key: string;
  lease_owner: string | null;
};

const STEP_COLUMNS = [
  'id',
  'run_id',
  'kind',
  'status',
  'attempt',
  'max_attempts',
  'timeout_ms',
  'payload',
  'idempotency_key',
  'lease_owner',
] as const;

const toStep = (row: StepRow): Step => ({
  id: row.id,
  runId: row.run_id,
  kind: row.kind,
  status: row.status,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  timeoutMs: row.timeout_ms,
  payload: row.payload,
  idempotencyKey: row.idempotency_key,
  leaseOwner: row.lease_owner,
});

const seconds = (ms: number) => sql`make_interval(secs => ${ms}::double precision / 1000)`;

/**
 * Adds a step inside the caller's transaction, so work is queued if and only
 * if the state change that requires it commits.
 */
export async function enqueueStep(
  db: Executor,
  input: EnqueueInput,
): Promise<{ stepId: string; created: boolean }> {
  const inserted = await db
    .insertInto('step')
    .values({
      run_id: input.runId,
      kind: input.kind,
      status: 'queued',
      idempotency_key: input.idempotencyKey,
      payload: JSON.stringify(input.payload ?? {}),
      ...(input.maxAttempts === undefined ? {} : { max_attempts: input.maxAttempts }),
      ...(input.timeoutMs === undefined ? {} : { timeout_ms: input.timeoutMs }),
      run_after: sql<Date>`now() + ${seconds(input.delayMs ?? 0)}`,
      lease_owner: null,
      lease_until: null,
      heartbeat_at: null,
      last_error: null,
      result: null,
      failure_class: null,
      finished_at: null,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!inserted) {
    const existing = await db
      .selectFrom('step')
      .select('id')
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirstOrThrow();
    return { stepId: existing.id, created: false };
  }

  await appendAuditEvent(db, input.runId, 'step.enqueued', {
    stepId: inserted.id,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
  });
  return { stepId: inserted.id, created: true };
}

/**
 * The durable work queue. Workers claim steps under a lease, extend it with
 * heartbeats, and report success or failure. Retries follow the retry policy;
 * steps that cannot succeed land in the dead-letter queue with every attempt
 * recorded. Each transition is an audit event.
 */
export class StepQueue {
  readonly #db: Kysely<Database>;
  readonly #policy: RetryPolicy;
  readonly #random: () => number;

  constructor(db: Kysely<Database>, options: { policy?: RetryPolicy; random?: () => number } = {}) {
    this.#db = db;
    this.#policy = options.policy ?? DEFAULT_RETRY_POLICY;
    this.#random = options.random ?? Math.random;
  }

  enqueue(input: EnqueueInput): Promise<{ stepId: string; created: boolean }> {
    return this.#db.transaction().execute((trx) => enqueueStep(trx, input));
  }

  /**
   * Writes billed model usage to the cost ledger. Called for every attempt
   * that spent tokens, including ones that failed, so the daily budget sees
   * the real spend.
   */
  async recordUsage(step: Pick<Step, 'id' | 'runId'>, usage: readonly ModelUsage[]): Promise<void> {
    if (usage.length === 0) {
      return;
    }
    await this.#db
      .insertInto('cost_ledger')
      .values(
        usage.map((u) => ({
          run_id: step.runId,
          step_id: step.id,
          model: u.model,
          tokens_in: u.inputTokens,
          tokens_out: u.outputTokens,
          usd: u.usd.toFixed(6),
        })),
      )
      .execute();
  }

  /**
   * Claims the oldest ready step of the given kinds. Concurrent workers never
   * receive the same step (FOR UPDATE SKIP LOCKED).
   */
  claim(worker: string, kinds: readonly string[], leaseMs: number): Promise<Step | null> {
    if (kinds.length === 0) {
      return Promise.resolve(null);
    }

    return this.#db.transaction().execute(async (trx) => {
      const { rows } = await sql<StepRow>`
        with next as (
          select id from step
          where status = 'queued' and run_after <= now() and kind = any(${[...kinds]}::text[])
          order by run_after, created_at
          for update skip locked
          limit 1
        )
        update step s
        set status = 'running',
            attempt = s.attempt + 1,
            lease_owner = ${worker},
            lease_until = now() + ${seconds(leaseMs)},
            heartbeat_at = now(),
            updated_at = now()
        from next
        where s.id = next.id
        returning ${sql.join(STEP_COLUMNS.map((c) => sql.ref(`s.${c}`)))}
      `.execute(trx);

      const row = rows[0];
      if (!row) {
        return null;
      }

      await trx
        .insertInto('step_attempt')
        .values({
          step_id: row.id,
          attempt: row.attempt,
          worker,
          finished_at: null,
          outcome: null,
          failure_class: null,
          error: null,
        })
        .execute();

      await appendAuditEvent(trx, row.run_id, 'step.started', {
        stepId: row.id,
        kind: row.kind,
        attempt: row.attempt,
        worker,
      });

      return toStep(row);
    });
  }

  /**
   * Extends the lease. Returns false when this worker no longer holds it
   * (the reaper took it back), in which case the worker must stop.
   */
  async heartbeat(stepId: string, worker: string, leaseMs: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('step')
      .set({
        lease_until: sql<Date>`now() + ${seconds(leaseMs)}`,
        heartbeat_at: sql<Date>`now()`,
      })
      .where('id', '=', stepId)
      .where('status', '=', 'running')
      .where('lease_owner', '=', worker)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /** Records success. Returns false if the lease was lost first; the result is then discarded. */
  complete(stepId: string, worker: string, result: unknown): Promise<boolean> {
    return this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('step')
        .set({
          status: 'succeeded',
          result: JSON.stringify(result ?? null),
          finished_at: sql<Date>`now()`,
          lease_owner: null,
          lease_until: null,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', stepId)
        .where('status', '=', 'running')
        .where('lease_owner', '=', worker)
        .returning(['run_id', 'kind', 'attempt'])
        .executeTakeFirst();

      if (!row) {
        return false;
      }

      await trx
        .updateTable('step_attempt')
        .set({ outcome: 'succeeded', finished_at: sql<Date>`now()` })
        .where('step_id', '=', stepId)
        .where('attempt', '=', row.attempt)
        .execute();

      await appendAuditEvent(trx, row.run_id, 'step.succeeded', {
        stepId,
        kind: row.kind,
        attempt: row.attempt,
      });
      return true;
    });
  }

  /**
   * Records a failed attempt and decides what happens next: back to the
   * queue after a backoff, or into the dead-letter queue. Returns null if
   * the lease was lost first.
   */
  fail(stepId: string, worker: string, failure: StepFailure): Promise<RetryDecision | null> {
    return this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('step')
        .select(STEP_COLUMNS)
        .where('id', '=', stepId)
        .where('status', '=', 'running')
        .where('lease_owner', '=', worker)
        .forUpdate()
        .executeTakeFirst();

      return row ? this.#recordFailure(trx, toStep(row), worker, failure) : null;
    });
  }

  /**
   * Takes back steps whose lease expired (worker crashed, hung, or lost its
   * connection) and handles each as a transient failure. Run periodically.
   */
  reapExpiredLeases(limit = 100): Promise<number> {
    return this.#db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('step')
        .select(STEP_COLUMNS)
        .where('status', '=', 'running')
        .where('lease_until', '<', sql<Date>`now()`)
        .orderBy('lease_until')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();

      for (const row of rows) {
        await this.#recordFailure(trx, toStep(row), row.lease_owner ?? 'unknown', {
          failureClass: 'transient',
          message: 'lease expired before the step finished',
        });
      }
      return rows.length;
    });
  }

  async listDeadLetters(limit = 50): Promise<DeadLetter[]> {
    const steps = await this.#db
      .selectFrom('step')
      .select([...STEP_COLUMNS, 'failure_class', 'last_error', 'finished_at'])
      .where('status', '=', 'dead_lettered')
      .orderBy('finished_at', 'desc')
      .limit(limit)
      .execute();

    if (steps.length === 0) {
      return [];
    }

    const attempts = await this.#db
      .selectFrom('step_attempt')
      .select(['step_id', 'attempt', 'worker', 'outcome', 'failure_class', 'error'])
      .where(
        'step_id',
        'in',
        steps.map((s) => s.id),
      )
      .orderBy('attempt')
      .execute();

    return steps.map((s) => ({
      step: toStep(s),
      failureClass: s.failure_class,
      lastError: s.last_error,
      finishedAt: s.finished_at,
      attempts: attempts
        .filter((a) => a.step_id === s.id)
        .map((a) => ({
          attempt: a.attempt,
          worker: a.worker,
          outcome: a.outcome,
          failureClass: a.failure_class,
          error: a.error,
        })),
    }));
  }

  /**
   * Puts a dead-lettered step back in the queue for one more attempt, and
   * records who did it. Returns false if the step is not dead-lettered.
   */
  replay(stepId: string, actor: string): Promise<boolean> {
    return this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('step')
        .set((eb) => ({
          status: 'queued',
          max_attempts: eb('attempt', '+', 1),
          run_after: sql<Date>`now()`,
          finished_at: null,
          updated_at: sql<Date>`now()`,
        }))
        .where('id', '=', stepId)
        .where('status', '=', 'dead_lettered')
        .returning(['run_id', 'kind', 'attempt'])
        .executeTakeFirst();

      if (!row) {
        return false;
      }

      await appendAuditEvent(trx, row.run_id, 'step.replayed', {
        stepId,
        kind: row.kind,
        afterAttempt: row.attempt,
        actor,
      });
      return true;
    });
  }

  async #recordFailure(
    trx: Transaction<Database>,
    step: Step,
    worker: string,
    failure: StepFailure,
  ): Promise<RetryDecision> {
    const decision = decideRetry(
      { ...this.#policy, maxAttempts: step.maxAttempts },
      failure.failureClass,
      step.attempt,
      failure.retryAfterMs,
      this.#random,
    );
    const status: StepStatus = decision.retry ? 'queued' : 'dead_lettered';

    await trx
      .updateTable('step')
      .set({
        status,
        failure_class: failure.failureClass,
        last_error: failure.message,
        lease_owner: null,
        lease_until: null,
        run_after: decision.retry ? sql<Date>`now() + ${seconds(decision.delayMs)}` : sql<Date>`run_after`,
        finished_at: decision.retry ? null : sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', step.id)
      .execute();

    await trx
      .updateTable('step_attempt')
      .set({
        outcome: decision.retry ? 'retry_scheduled' : 'dead_lettered',
        failure_class: failure.failureClass,
        error: JSON.stringify({ message: failure.message, worker, details: failure.details ?? null }),
        finished_at: sql<Date>`now()`,
      })
      .where('step_id', '=', step.id)
      .where('attempt', '=', step.attempt)
      .execute();

    await appendAuditEvent(trx, step.runId, decision.retry ? 'step.retry_scheduled' : 'step.dead_lettered', {
      stepId: step.id,
      kind: step.kind,
      attempt: step.attempt,
      failureClass: failure.failureClass,
      error: failure.message.slice(0, MAX_AUDITED_ERROR),
      reason: decision.reason,
      ...(decision.retry ? { delayMs: Math.round(decision.delayMs) } : {}),
    });

    return decision;
  }
}
