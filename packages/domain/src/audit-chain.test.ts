import { describe, expect, it } from 'vitest';
import {
  type AuditEvent,
  computeAuditHash,
  formatAuditTimestamp,
  GENESIS_HASH,
  verifyChain,
} from './audit-chain.ts';
import { canonicalJson } from './canonical-json.ts';

describe('computeAuditHash', () => {
  // Vectors produced by the audit_hash SQL function in db/migrations/0001_init.sql.
  // If either implementation changes, these fail and existing chains stop verifying.
  it('matches Postgres for an event without a run', () => {
    const hash = computeAuditHash({
      prevHash: GENESIS_HASH,
      seq: 1,
      at: '2026-11-02T20:00:00.123456Z',
      runId: null,
      type: 'factory.started',
      payload: '{"version":"0.1.0"}',
    });

    expect(hash).toBe('ad1247ea59d382e8c30f870f23e58c0a0b9e890d26c839a4b8b877a910e7bcbf');
  });

  it('matches Postgres for an event with a run and an escaped payload', () => {
    const hash = computeAuditHash({
      prevHash: 'abc',
      seq: 7,
      at: '2026-01-31T23:59:59.000001Z',
      runId: '11111111-2222-3333-4444-555555555555',
      type: 'run.created',
      payload: '{"a":"hé"}', // non-ASCII must hash as UTF-8
    });

    expect(hash).toBe('6b05d47bb1fec2711f2834dfa0903f71df101f14cfaf6cab2e2232a5f6e37e67');
  });
});

describe('formatAuditTimestamp', () => {
  it('prints UTC with six fractional digits', () => {
    expect(formatAuditTimestamp(new Date('2026-11-02T13:00:00.123-07:00'))).toBe(
      '2026-11-02T20:00:00.123000Z',
    );
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain', () => {
    const chain = buildChain(3);

    expect(verifyChain(chain)).toEqual({ valid: true, eventCount: 3, headHash: chain.at(-1)?.hash });
  });

  it('accepts an empty chain', () => {
    expect(verifyChain([])).toEqual({ valid: true, eventCount: 0, headHash: GENESIS_HASH });
  });

  it('detects an edited payload', () => {
    const chain = buildChain(3);
    chain[1] = { ...at(chain, 1), payload: '{"n":999}' };

    expect(verifyChain(chain)).toMatchObject({
      valid: false,
      brokenAtSeq: 2,
      problem: 'hash does not match contents',
    });
  });

  it('detects a re-hashed forgery because the next link breaks', () => {
    const chain = buildChain(3);
    const forged = { ...at(chain, 1), payload: '{"n":999}' };
    chain[1] = { ...forged, hash: computeAuditHash(forged) };

    expect(verifyChain(chain)).toMatchObject({
      valid: false,
      brokenAtSeq: 3,
      problem: 'prev_hash does not match previous event',
    });
  });

  it('detects a deleted event', () => {
    const chain = buildChain(3);
    chain.splice(1, 1);

    expect(verifyChain(chain)).toMatchObject({ valid: false, brokenAtSeq: 3 });
  });
});

function at(chain: AuditEvent[], index: number): AuditEvent {
  const event = chain[index];
  if (!event) throw new Error(`no event at ${index}`);
  return event;
}

function buildChain(count: number): AuditEvent[] {
  const events: AuditEvent[] = [];
  let prevHash = GENESIS_HASH;
  for (let seq = 1; seq <= count; seq++) {
    const event = {
      seq,
      at: formatAuditTimestamp(new Date(Date.UTC(2026, 10, 2, 20, 0, seq))),
      runId: null,
      type: 'test.event',
      payload: canonicalJson({ n: seq }),
      prevHash,
    };
    const hash = computeAuditHash(event);
    events.push({ ...event, hash });
    prevHash = hash;
  }
  return events;
}
