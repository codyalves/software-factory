import type { Kysely, Transaction } from 'kysely';
import type { Database } from './database.ts';

/**
 * Records a side effect (an issue comment, later a merge) to be sent by the
 * outbox relay. Written in the same transaction as the state change that
 * causes it, so the effect happens if and only if the change commits.
 */
export async function enqueueOutbox(
  db: Kysely<Database> | Transaction<Database>,
  runId: string,
  kind: string,
  payload: unknown,
): Promise<void> {
  await db
    .insertInto('outbox')
    .values({ run_id: runId, kind, payload: JSON.stringify(payload), sent_at: null })
    .execute();
}
