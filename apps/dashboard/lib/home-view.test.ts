import { RUN_STATES } from '@factory/domain';
import { describe, expect, it } from 'vitest';
import { elapsed, plainState, STAGES, stageOf, WORDED_STATES } from './home-view.ts';

describe('home screen wording', () => {
  it('has plain words for every state a run can be in', () => {
    expect([...WORDED_STATES].sort()).toEqual([...RUN_STATES].sort());
  });

  it('puts every moving state on a stage, in order, and no resting state on one', () => {
    expect(['Intake', 'Triage', 'Planning', 'Implementing', 'Gating', 'Merging'].map(stageOf)).toEqual([
      0, 0, 1, 2, 3, 4,
    ]);
    expect(['Merged', 'Reviewing', 'Escalated', 'Rejected', 'Cancelled'].map(stageOf)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(STAGES[stageOf('Implementing') ?? -1]).toBe('Write code');
  });

  it('marks held work as waiting on the reader and a stopped run as stopped', () => {
    expect(plainState('Reviewing')).toEqual({ words: 'Needs your approval', tone: 'wait' });
    expect(plainState('Escalated').tone).toBe('stop');
    expect(plainState('Merged')).toEqual({ words: 'Shipped', tone: 'ok' });
  });

  it('says how long a session has been running', () => {
    const start = '2026-11-25T23:38:04Z';
    const at = (iso: string) => Date.parse(iso);
    expect(elapsed(start, at('2026-11-25T23:38:40Z'))).toBe('under a minute');
    expect(elapsed(start, at('2026-11-25T23:44:30Z'))).toBe('6 min');
    expect(elapsed(start, at('2026-11-26T00:38:04Z'))).toBe('1 h');
    expect(elapsed(start, at('2026-11-26T00:50:10Z'))).toBe('1 h 12 min');
  });
});
