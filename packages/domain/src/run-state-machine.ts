export const RUN_STATES = [
  'Intake',
  'Triage',
  'Planning',
  'Implementing',
  'Gating',
  'Reviewing',
  'Merging',
  'Merged',
  'Escalated',
  'Rejected',
  'Cancelled',
] as const;

export type RunState = (typeof RUN_STATES)[number];

export type TransitionResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Implement attempts allowed before a run must escalate to a human. */
export const MAX_IMPLEMENT_ATTEMPTS = 4;

const FORWARD: Readonly<Partial<Record<RunState, readonly RunState[]>>> = {
  Intake: ['Triage'],
  Triage: ['Planning', 'Rejected'],
  Planning: ['Implementing'],
  Implementing: ['Gating'],
  // A failed gate or a rejecting review goes back to Implementing with the
  // failure as input. That is agent iteration, not an infrastructure retry.
  Gating: ['Reviewing', 'Implementing'],
  Reviewing: ['Merging', 'Implementing'],
  Merging: ['Merged'],
};

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: RunState): boolean {
  return state === 'Merged' || state === 'Escalated' || state === 'Rejected' || state === 'Cancelled';
}

/**
 * The run lifecycle. Deterministic code owns every transition; models only
 * supply inputs to the decisions at branch points.
 *
 * @param implementAttempts Implement attempts already made in this run.
 */
export function evaluateTransition(
  from: RunState,
  to: RunState,
  implementAttempts: number,
): TransitionResult {
  if (isTerminal(from)) {
    return { allowed: false, reason: `${from} is terminal` };
  }

  // A human or a spent budget can stop any active run.
  if (to === 'Escalated' || to === 'Cancelled') {
    return { allowed: true };
  }

  if (!FORWARD[from]?.includes(to)) {
    return { allowed: false, reason: `${from} cannot move to ${to}` };
  }

  if (to === 'Implementing' && implementAttempts >= MAX_IMPLEMENT_ATTEMPTS) {
    return { allowed: false, reason: `attempt cap of ${MAX_IMPLEMENT_ATTEMPTS} reached; escalate instead` };
  }

  return { allowed: true };
}
