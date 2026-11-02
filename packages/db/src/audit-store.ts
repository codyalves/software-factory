import { type AuditEvent, type ChainVerification, canonicalJson, verifyChain } from '@factory/domain';
import { type Kysely, sql } from 'kysely';
import type { Database } from './database.ts';

interface AuditRow {
  seq: string;
  at: string;
  run_id: string | null;
  type: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

// Timestamps leave Postgres as text with all six fractional digits. A JS Date
// only holds milliseconds, and the hash covers microseconds.
const COLUMNS = sql.raw(
  `seq, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, run_id, type, payload, prev_hash, hash`,
);

const toEvent = (row: AuditRow): AuditEvent => ({
  seq: Number(row.seq),
  at: row.at,
  runId: row.run_id,
  type: row.type,
  payload: row.payload,
  prevHash: row.prev_hash.trim(),
  hash: row.hash.trim(),
});

/**
 * Appends one audit event through the audit_append SQL function, which
 * serializes writers and computes the hash in the database. Pass the
 * transaction that makes the change, so the event commits with it.
 */
export async function appendAuditEvent(
  db: Kysely<Database>,
  runId: string | null,
  type: string,
  payload: unknown,
): Promise<AuditEvent> {
  const { rows } = await sql<AuditRow>`
    select ${COLUMNS} from audit_append(${runId}::uuid, ${type}, ${canonicalJson(payload)})
  `.execute(db);
  const row = rows[0];
  if (!row) {
    throw new Error('audit_append returned no row');
  }
  return toEvent(row);
}

export class AuditStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async readAll(): Promise<AuditEvent[]> {
    const { rows } = await sql<AuditRow>`select ${COLUMNS} from audit_event order by seq`.execute(this.#db);
    return rows.map(toEvent);
  }

  /** Recomputes the chain in application code. */
  async verify(): Promise<ChainVerification> {
    return verifyChain(await this.readAll());
  }

  /** Recomputes the chain inside Postgres with the audit_verify function. */
  async verifyInDatabase(): Promise<{ seq: number; problem: string }[]> {
    const { rows } = await sql<{
      seq: string;
      problem: string;
    }>`select seq, problem from audit_verify()`.execute(this.#db);
    return rows.map((row) => ({ seq: Number(row.seq), problem: row.problem }));
  }
}
