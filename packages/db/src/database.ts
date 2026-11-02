import type { FailureClass, RunState } from '@factory/domain';
import { type ColumnType, type Generated, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

// Column types for the tables written through the query builder. The audit
// log is only ever touched through its SQL functions (see audit-store.ts).

interface RequirementTable {
  id: Generated<string>;
  repo: string;
  issue_number: number;
  title: string;
  body: string;
  risk_level: ColumnType<'low' | 'medium' | 'high' | null, never, 'low' | 'medium' | 'high'>;
  created_at: Generated<Date>;
}

interface RunTable {
  id: Generated<string>;
  requirement_id: string;
  state: RunState;
  implement_attempts: Generated<number>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, never, Date>;
}

interface InboundDeliveryTable {
  delivery_id: string;
  source: string;
  received_at: Generated<Date>;
}

export type StepStatus = 'queued' | 'running' | 'succeeded' | 'dead_lettered';

interface StepTable {
  id: Generated<string>;
  run_id: string;
  kind: string;
  status: StepStatus;
  attempt: Generated<number>;
  idempotency_key: string;
  payload: ColumnType<unknown, string, string>;
  max_attempts: Generated<number>;
  timeout_ms: Generated<number>;
  run_after: Generated<Date>;
  lease_owner: string | null;
  lease_until: Date | null;
  heartbeat_at: Date | null;
  last_error: string | null;
  result: ColumnType<unknown, string | null, string | null>;
  failure_class: FailureClass | null;
  finished_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface StepAttemptTable {
  step_id: string;
  attempt: number;
  worker: string;
  started_at: Generated<Date>;
  finished_at: Date | null;
  outcome: 'succeeded' | 'retry_scheduled' | 'dead_lettered' | null;
  failure_class: FailureClass | null;
  error: ColumnType<unknown, string | null, string | null>;
}

interface OutboxTable {
  id: Generated<string>;
  run_id: string;
  kind: string;
  payload: ColumnType<unknown, string, never>;
  attempts: Generated<number>;
  created_at: Generated<Date>;
  sent_at: Date | null;
}

export interface Database {
  requirement: RequirementTable;
  run: RunTable;
  inbound_delivery: InboundDeliveryTable;
  step: StepTable;
  step_attempt: StepAttemptTable;
  outbox: OutboxTable;
}

export interface FactoryDb {
  readonly db: Kysely<Database>;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /**
   * Called when an idle pooled connection dies (database restart, failover,
   * admin termination). Without a handler, pg crashes the process; the pool
   * replaces the connection on next use.
   */
  onIdleError?: (error: Error) => void;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): FactoryDb {
  const pool = new pg.Pool({ connectionString });
  pool.on(
    'error',
    options.onIdleError ?? ((error) => console.error('idle Postgres connection failed', error)),
  );
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  // Kysely's destroy() also ends the pool.
  return { db, pool, close: () => db.destroy() };
}
