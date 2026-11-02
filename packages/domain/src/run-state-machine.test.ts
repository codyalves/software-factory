import { describe, expect, it } from 'vitest';
import { evaluateTransition, MAX_IMPLEMENT_ATTEMPTS, type RunState } from './run-state-machine.ts';

describe('run state machine', () => {
  it.each<[RunState, RunState]>([
    ['Intake', 'Triage'],
    ['Triage', 'Planning'],
    ['Triage', 'Rejected'],
    ['Planning', 'Implementing'],
    ['Implementing', 'Gating'],
    ['Gating', 'Reviewing'],
    ['Reviewing', 'Merging'],
    ['Merging', 'Merged'],
  ])('allows %s -> %s', (from, to) => {
    expect(evaluateTransition(from, to, 0).allowed).toBe(true);
  });

  it.each<[RunState, RunState]>([
    ['Intake', 'Implementing'],
    ['Planning', 'Merging'],
    ['Gating', 'Merging'],
    ['Implementing', 'Reviewing'],
  ])('denies skipping a stage: %s -> %s', (from, to) => {
    expect(evaluateTransition(from, to, 0).allowed).toBe(false);
  });

  it('lets a failed gate iterate until the cap, then requires escalation', () => {
    expect(evaluateTransition('Gating', 'Implementing', MAX_IMPLEMENT_ATTEMPTS - 1).allowed).toBe(true);

    const capped = evaluateTransition('Gating', 'Implementing', MAX_IMPLEMENT_ATTEMPTS);

    expect(capped).toEqual({ allowed: false, reason: expect.stringContaining('escalate') });
    expect(evaluateTransition('Gating', 'Escalated', MAX_IMPLEMENT_ATTEMPTS).allowed).toBe(true);
  });

  it.each<RunState>(['Merged', 'Escalated', 'Rejected', 'Cancelled'])('keeps %s terminal', (terminal) => {
    expect(evaluateTransition(terminal, 'Cancelled', 0).allowed).toBe(false);
    expect(evaluateTransition(terminal, 'Triage', 0).allowed).toBe(false);
  });
});
