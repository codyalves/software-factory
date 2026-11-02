import { createHash } from 'node:crypto';

/** One link in the audit chain, exactly as stored. */
export interface AuditEvent {
  readonly seq: number;
  /** UTC timestamp with microseconds, e.g. `2026-11-02T20:00:00.123456Z`. */
  readonly at: string;
  readonly runId: string | null;
  readonly type: string;
  /** Canonical JSON text. */
  readonly payload: string;
  readonly prevHash: string;
  readonly hash: string;
}

export type ChainVerification =
  | { readonly valid: true; readonly eventCount: number; readonly headHash: string }
  | {
      readonly valid: false;
      readonly eventCount: number;
      readonly headHash: string;
      readonly brokenAtSeq: number;
      readonly problem: string;
    };

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Formats a Date the way Postgres prints the audit timestamp. JavaScript Dates
 * hold milliseconds, so the last three digits are zero; timestamps read back
 * from Postgres keep all six as text and never pass through a Date.
 */
export function formatAuditTimestamp(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/**
 * The hash-chain formula, mirrored from the `audit_hash` SQL function in
 * db/migrations/0001_init.sql so exported chains can be verified without the
 * database. Changing either side breaks verification of every existing chain.
 */
export function computeAuditHash(event: Omit<AuditEvent, 'hash'>): string {
  const input = [
    event.prevHash,
    String(event.seq),
    event.at,
    event.runId ?? '',
    event.type,
    event.payload,
  ].join('\n');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Walks events in order and stops at the first problem: a gap in the
 * sequence, a broken link to the previous hash, or contents that no longer
 * match their hash.
 */
export function verifyChain(events: Iterable<AuditEvent>): ChainVerification {
  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  let count = 0;

  const broken = (seq: number, problem: string): ChainVerification => ({
    valid: false,
    eventCount: count,
    headHash: expectedPrev,
    brokenAtSeq: seq,
    problem,
  });

  for (const event of events) {
    if (event.seq !== expectedSeq) {
      return broken(event.seq, `expected seq ${expectedSeq}`);
    }
    if (event.prevHash !== expectedPrev) {
      return broken(event.seq, 'prev_hash does not match previous event');
    }
    if (computeAuditHash(event) !== event.hash) {
      return broken(event.seq, 'hash does not match contents');
    }
    expectedPrev = event.hash;
    expectedSeq++;
    count++;
  }

  return { valid: true, eventCount: count, headHash: expectedPrev };
}
