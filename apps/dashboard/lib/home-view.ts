/**
 * The home screen says where work is in plain words, not in the factory's
 * state names: the reader wants to know what is happening and whether it
 * needs them, and the run record keeps the exact states.
 */

/** The steps every issue goes through, in order, as the home screen names them. */
export const STAGES = ['Read', 'Plan', 'Write code', 'Check', 'Merge'] as const;

const STAGE_OF: Readonly<Record<string, number>> = {
  Intake: 0,
  Triage: 0,
  Planning: 1,
  Implementing: 2,
  Gating: 3,
  Merging: 4,
};

/** Which stage a run in progress is on, or null once it has stopped moving. */
export function stageOf(state: string): number | null {
  return STAGE_OF[state] ?? null;
}

export type Tone = 'now' | 'ok' | 'wait' | 'stop' | 'quiet';

const PLAIN: Readonly<Record<string, { words: string; tone: Tone }>> = {
  Intake: { words: 'Reading the request', tone: 'now' },
  Triage: { words: 'Reading the request', tone: 'now' },
  Planning: { words: 'Planning the work', tone: 'now' },
  Implementing: { words: 'Writing code', tone: 'now' },
  Gating: { words: 'Running checks', tone: 'now' },
  Merging: { words: 'Merging', tone: 'now' },
  Merged: { words: 'Shipped', tone: 'ok' },
  Reviewing: { words: 'Needs your approval', tone: 'wait' },
  Escalated: { words: 'Stopped: needs a person', tone: 'stop' },
  Rejected: { words: 'Turned down', tone: 'quiet' },
  Cancelled: { words: 'Cancelled', tone: 'quiet' },
};

/** The states the home screen has words for; a test holds this to every state a run can be in. */
export const WORDED_STATES: readonly string[] = Object.keys(PLAIN);

/** A run's state as the home screen says it, and how it should read at a glance. */
export function plainState(state: string): { words: string; tone: Tone } {
  return PLAIN[state] ?? { words: state, tone: 'quiet' };
}

/** How long something has been going: "under a minute", "6 min", "1 h 12 min". */
export function elapsed(startedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(startedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}
