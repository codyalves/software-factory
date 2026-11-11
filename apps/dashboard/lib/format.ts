/** Money at the precision that matters: cents above a dollar, tenths of a cent below. */
export function usd(amount: number): string {
  if (amount === 0) return '$0';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

/** "2026-11-10 01:05 UTC": records are kept in UTC, so they are shown in UTC. */
export function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "01:05:46" for times within one run's record. */
export function clock(iso: string): string {
  return iso.slice(11, 19);
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : '';
}

export function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

/** Plain words for run states, for people who do not know the state machine. */
export const STATE_LABEL: Readonly<Record<string, string>> = {
  Intake: 'Received',
  Triage: 'Triaging',
  Planning: 'Planning',
  Implementing: 'Implementing',
  Gating: 'Checking',
  Reviewing: 'Awaiting review',
  Merging: 'Merging',
  Merged: 'Merged',
  Escalated: 'Needs a person',
  Rejected: 'Rejected',
  Cancelled: 'Cancelled',
};

/** How a state should read: finished well, stopped, or still moving. */
export function stateTone(state: string): 'good' | 'stopped' | 'active' | 'neutral' {
  if (state === 'Reviewing' || state === 'Merged') return 'good';
  if (state === 'Escalated') return 'stopped';
  if (state === 'Rejected' || state === 'Cancelled') return 'neutral';
  return 'active';
}

export function issueUrl(repo: string, issueNumber: number): string {
  return `https://github.com/${repo}/issues/${issueNumber}`;
}

export function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

/** year.test.js:4 at a commit -> the line on GitHub. */
export function testUrl(repo: string, testId: string, sha: string): string {
  const [path, line] = testId.split(/:(?=\d+$)/);
  return `https://github.com/${repo}/blob/${sha}/${path}${line ? `#L${line}` : ''}`;
}
