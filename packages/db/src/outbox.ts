import { DEFAULT_RETRY_POLICY, decideRetry, type FailureClass, type RetryPolicy } from '@factory/domain';
import { type Kysely, sql, type Transaction } from 'kysely';
import { appendAuditEvent } from './audit-store.ts';
import type { Database } from './database.ts';

/**
 * Records a side effect (an issue comment, later a merge) to be sent by the
 * outbox relay. Written in the same transaction as the state change that
 * causes it, so the effect happens if and only if the change commits.
 */
export async function enqueueOutbox(
  db: Kysely<Database> | Transaction<Database>,
  /** Null for messages that belong to no run, such as the tester's issues. */
  runId: string | null,
  kind: string,
  payload: unknown,
): Promise<void> {
  await db
    .insertInto('outbox')
    .values({ run_id: runId, kind, payload: JSON.stringify(payload), sent_at: null })
    .execute();
}

export interface OutboxMessage {
  readonly id: string;
  readonly runId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  /** Failed attempts so far. Above zero, an earlier attempt may have reached the other side. */
  readonly attempts: number;
}

export interface DeliveryFailure {
  readonly failureClass: FailureClass;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export type Delivery =
  | { readonly outcome: 'sent'; readonly id: string; readonly kind: string; readonly result: unknown }
  | {
      readonly outcome: 'retry_scheduled' | 'failed';
      readonly id: string;
      readonly kind: string;
      readonly error: string;
    };

/**
 * Delivers outbox messages one at a time. The row stays locked while it is
 * sent, so two relays never send the same message; the send happens before
 * the outcome commits, so delivery is at-least-once, and senders make it
 * effectively once (the GitHub adapter dedupes comments on retry).
 */
export class OutboxRelay {
  readonly #db: Kysely<Database>;
  readonly #policy: RetryPolicy;
  readonly #random: () => number;

  constructor(db: Kysely<Database>, options: { policy?: RetryPolicy; random?: () => number } = {}) {
    this.#db = db;
    this.#policy = options.policy ?? { ...DEFAULT_RETRY_POLICY, maxAttempts: 8 };
    this.#random = options.random ?? Math.random;
  }

  /**
   * Sends the oldest due message. `send` returns the result to record, or
   * throws; `classify` turns what it threw into a delivery failure. Returns
   * null when nothing is due.
   */
  deliverNext(
    send: (message: OutboxMessage) => Promise<unknown>,
    classify: (error: unknown) => DeliveryFailure,
  ): Promise<Delivery | null> {
    return this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('outbox')
        .select(['id', 'run_id', 'kind', 'payload', 'attempts'])
        .where('sent_at', 'is', null)
        .where('failed_at', 'is', null)
        .where('next_attempt_at', '<=', sql<Date>`now()`)
        .orderBy('next_attempt_at')
        .orderBy('id')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!row) {
        return null;
      }

      const message: OutboxMessage = {
        id: String(row.id),
        runId: row.run_id,
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts,
      };

      let result: unknown;
      try {
        result = await send(message);
      } catch (error) {
        return this.#recordFailure(trx, message, classify(error));
      }

      await trx
        .updateTable('outbox')
        .set({ sent_at: sql<Date>`now()`, result: JSON.stringify(result ?? null), last_error: null })
        .where('id', '=', message.id)
        .execute();
      await appendAuditEvent(trx, message.runId, 'outbox.sent', {
        outboxId: message.id,
        kind: message.kind,
        attempt: message.attempts + 1,
        result,
      });
      return { outcome: 'sent', id: message.id, kind: message.kind, result };
    });
  }

  async #recordFailure(
    trx: Transaction<Database>,
    message: OutboxMessage,
    failure: DeliveryFailure,
  ): Promise<Delivery> {
    const attempt = message.attempts + 1;
    const decision = decideRetry(
      this.#policy,
      failure.failureClass,
      attempt,
      failure.retryAfterMs,
      this.#random,
    );

    await trx
      .updateTable('outbox')
      .set({
        attempts: attempt,
        last_error: failure.message,
        next_attempt_at: decision.retry
          ? sql<Date>`now() + make_interval(secs => ${decision.delayMs}::double precision / 1000)`
          : sql<Date>`next_attempt_at`,
        failed_at: decision.retry ? null : sql<Date>`now()`,
      })
      .where('id', '=', message.id)
      .execute();

    await appendAuditEvent(trx, message.runId, decision.retry ? 'outbox.retry_scheduled' : 'outbox.failed', {
      outboxId: message.id,
      kind: message.kind,
      attempt,
      failureClass: failure.failureClass,
      error: failure.message.slice(0, 500),
      reason: decision.reason,
    });

    return {
      outcome: decision.retry ? 'retry_scheduled' : 'failed',
      id: message.id,
      kind: message.kind,
      error: failure.message,
    };
  }
}
