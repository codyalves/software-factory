import { evaluateTransition, type ForgeIssue, type RunState } from '@factory/domain';
import { type Kysely, sql } from 'kysely';
import { appendAuditEvent } from './audit-store.ts';
import type { Database } from './database.ts';

export interface RunSummary {
  readonly id: string;
  readonly requirementId: string;
  readonly state: RunState;
  readonly implementAttempts: number;
}

export type IntakeResult =
  | { readonly outcome: 'created'; readonly runId: string }
  | { readonly outcome: 'duplicate-delivery' }
  | { readonly outcome: 'already-active' };

const TERMINAL_STATES: RunState[] = ['Merged', 'Escalated', 'Rejected', 'Cancelled'];

/**
 * Run lifecycle persistence. Every state change and its audit event commit in
 * the same transaction, so the record can never disagree with the state.
 */
export class RunStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /**
   * Turns an inbound issue into a requirement and a new run. A redelivered
   * webhook (same delivery id) changes nothing.
   */
  createFromIssue(issue: ForgeIssue, source: string, deliveryId: string): Promise<IntakeResult> {
    return this.#db.transaction().execute(async (trx) => {
      const delivery = await trx
        .insertInto('inbound_delivery')
        .values({ delivery_id: deliveryId, source })
        .onConflict((oc) => oc.doNothing())
        .executeTakeFirst();

      if (delivery.numInsertedOrUpdatedRows === 0n) {
        return { outcome: 'duplicate-delivery' };
      }

      const requirement = await trx
        .insertInto('requirement')
        .values({ repo: issue.repo, issue_number: issue.number, title: issue.title, body: issue.body })
        .onConflict((oc) =>
          oc.columns(['repo', 'issue_number']).doUpdateSet((eb) => ({
            title: eb.ref('excluded.title'),
            body: eb.ref('excluded.body'),
          })),
        )
        .returning('id')
        .executeTakeFirstOrThrow();

      // At most one active run per requirement (partial unique index).
      const run = await trx
        .insertInto('run')
        .values({ requirement_id: requirement.id, state: 'Intake' })
        .onConflict((oc) => oc.column('requirement_id').where('state', 'not in', TERMINAL_STATES).doNothing())
        .returning('id')
        .executeTakeFirst();

      await appendAuditEvent(trx, run?.id ?? null, 'requirement.received', {
        source,
        deliveryId,
        repo: issue.repo,
        issue: issue.number,
        title: issue.title,
        labels: issue.labels,
      });

      if (!run) {
        return { outcome: 'already-active' };
      }

      await appendAuditEvent(trx, run.id, 'run.created', { requirementId: requirement.id, state: 'Intake' });
      return { outcome: 'created', runId: run.id };
    });
  }

  async get(runId: string): Promise<RunSummary | null> {
    const row = await this.#db
      .selectFrom('run')
      .select(['id', 'requirement_id', 'state', 'implement_attempts'])
      .where('id', '=', runId)
      .executeTakeFirst();
    return row ? toSummary(row) : null;
  }

  /**
   * Claims the oldest run in `from` (skipping rows another orchestrator holds)
   * and moves it to `to`. Returns null when nothing is waiting.
   */
  advanceNext(from: RunState, to: RunState, reason: string): Promise<RunSummary | null> {
    return this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('run')
        .select(['id', 'requirement_id', 'state', 'implement_attempts'])
        .where('state', '=', from)
        .orderBy('created_at')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!row) {
        return null;
      }

      const run = toSummary(row);
      const check = evaluateTransition(run.state, to, run.implementAttempts);
      if (!check.allowed) {
        throw new Error(`Run ${run.id}: ${check.reason}`);
      }

      const implementAttempts = to === 'Implementing' ? run.implementAttempts + 1 : run.implementAttempts;

      await trx
        .updateTable('run')
        .set({ state: to, implement_attempts: implementAttempts, updated_at: sql<Date>`now()` })
        .where('id', '=', run.id)
        .execute();

      await appendAuditEvent(trx, run.id, 'run.state_changed', {
        from: run.state,
        to,
        reason,
        implementAttempts,
      });

      return { ...run, state: to, implementAttempts };
    });
  }
}

function toSummary(row: {
  id: string;
  requirement_id: string;
  state: RunState;
  implement_attempts: number;
}): RunSummary {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    state: row.state,
    implementAttempts: row.implement_attempts,
  };
}
