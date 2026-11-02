import { type Kysely, sql } from 'kysely';
import { appendAuditEvent } from './audit-store.ts';
import type { Database } from './database.ts';

export interface FactoryStatus {
  readonly paused: boolean;
  readonly reason: string | null;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly dailyBudgetUsd: number;
  readonly budgetTimeZone: string;
  /** Spend since midnight in the budget's time zone. */
  readonly spentTodayUsd: number;
  readonly remainingTodayUsd: number;
}

export type WorkPermission = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Throws unless the name is an IANA time zone the runtime knows. */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new RangeError(`unknown time zone: ${timeZone}`);
  }
}

/**
 * The factory's operating state: a pause switch and a daily spend cap.
 * Every change is an audit event committed with the change itself.
 *
 * The cap is checked before a step is claimed, so it is soft: one step that
 * starts under the cap can finish over it. Steps are small (a triage call costs
 * well under a cent), so the overshoot is bounded by the most expensive step.
 */
export class FactoryControl {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async status(): Promise<FactoryStatus> {
    const { rows } = await sql<{
      paused: boolean;
      reason: string | null;
      changed_by: string;
      changed_at: string;
      daily_budget_usd: string;
      budget_time_zone: string;
      spent_today: string;
    }>`
      select c.paused, c.reason, c.changed_by,
             to_char(c.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as changed_at,
             c.daily_budget_usd::text as daily_budget_usd,
             c.budget_time_zone,
             coalesce((
               select sum(l.usd) from cost_ledger l
               where l.at >= (date_trunc('day', now() at time zone c.budget_time_zone)
                              at time zone c.budget_time_zone)
             ), 0)::text as spent_today
      from factory_control c
    `.execute(this.#db);
    const row = rows[0];
    if (!row) {
      throw new Error('factory_control has no row; run the migrations');
    }
    const budget = Number(row.daily_budget_usd);
    const spent = Number(row.spent_today);
    return {
      paused: row.paused,
      reason: row.reason,
      changedBy: row.changed_by,
      changedAt: row.changed_at,
      dailyBudgetUsd: budget,
      budgetTimeZone: row.budget_time_zone,
      spentTodayUsd: spent,
      remainingTodayUsd: Math.max(0, budget - spent),
    };
  }

  /** Whether workers may claim new steps. */
  async allowsWork(): Promise<WorkPermission> {
    const s = await this.status();
    if (s.paused) {
      return { ok: false, reason: `paused by ${s.changedBy}${s.reason ? `: ${s.reason}` : ''}` };
    }
    if (s.spentTodayUsd >= s.dailyBudgetUsd) {
      return {
        ok: false,
        reason: `daily budget reached ($${s.spentTodayUsd.toFixed(4)} of $${s.dailyBudgetUsd.toFixed(2)}, resets at midnight ${s.budgetTimeZone})`,
      };
    }
    return { ok: true };
  }

  /** Whether the outbox relay may send. Only the pause switch applies: sends cost nothing. */
  async allowsSending(): Promise<WorkPermission> {
    const s = await this.status();
    return s.paused ? { ok: false, reason: `paused by ${s.changedBy}` } : { ok: true };
  }

  pause(actor: string, reason: string): Promise<FactoryStatus> {
    return this.#setPaused(true, actor, reason);
  }

  resume(actor: string): Promise<FactoryStatus> {
    return this.#setPaused(false, actor, null);
  }

  async setBudget(actor: string, dailyBudgetUsd: number, timeZone?: string): Promise<FactoryStatus> {
    if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0 || dailyBudgetUsd > 1000) {
      throw new RangeError('daily budget must be between 0 and 1000 USD');
    }
    if (timeZone !== undefined) {
      assertTimeZone(timeZone);
    }
    await this.#db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom('factory_control')
        .select(['daily_budget_usd', 'budget_time_zone'])
        .forUpdate()
        .executeTakeFirstOrThrow();
      const after = {
        daily_budget_usd: dailyBudgetUsd.toFixed(2),
        budget_time_zone: timeZone ?? before.budget_time_zone,
      };
      await trx.updateTable('factory_control').set(after).execute();
      await appendAuditEvent(trx, null, 'factory.budget_changed', {
        actor,
        from: { dailyBudgetUsd: before.daily_budget_usd, timeZone: before.budget_time_zone },
        to: { dailyBudgetUsd: after.daily_budget_usd, timeZone: after.budget_time_zone },
      });
    });
    return this.status();
  }

  async #setPaused(paused: boolean, actor: string, reason: string | null): Promise<FactoryStatus> {
    await this.#db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom('factory_control')
        .select('paused')
        .forUpdate()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('factory_control')
        .set({ paused, reason, changed_by: actor, changed_at: new Date() })
        .execute();
      // A repeated pause or resume is still recorded: someone asked for it.
      await appendAuditEvent(trx, null, paused ? 'factory.paused' : 'factory.resumed', {
        actor,
        reason,
        wasPaused: before.paused,
      });
    });
    return this.status();
  }
}
