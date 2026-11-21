'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  activeSessions,
  controlConfig,
  currentOwner,
  fileIssue,
  startBacklogSession,
  stopSession,
} from '@/lib/control';
import { requestDraft } from '@/lib/requests';

/**
 * Every action re-checks, on the server, that an owner is signed in: hiding
 * a button is not access control. Each one acts through GitHub as the
 * factory's App; GitHub and the factory's audit log record what happened.
 */
async function owner() {
  const config = controlConfig();
  const login = await currentOwner();
  if (!config || !login) throw new Error('Only a signed-in owner can do that.');
  return { config, login };
}

export async function fileRequestAction(
  _previous: { error: string | null },
  form: FormData,
): Promise<{ error: string | null }> {
  const { config, login } = await owner();
  const draft = requestDraft({
    title: String(form.get('title') ?? ''),
    description: String(form.get('description') ?? ''),
    criteria: String(form.get('criteria') ?? ''),
    dependsOn: String(form.get('dependsOn') ?? ''),
    requestedBy: login,
  });
  if (!draft.ok) return { error: draft.error };
  const issue = await fileIssue(config, draft);
  revalidatePath('/backlog');
  redirect(`/backlog?filed=${issue.number}`);
}

export async function startSessionAction(form: FormData): Promise<void> {
  const { config, login } = await owner();
  if ((await activeSessions(config)).length > 0) throw new Error('A factory session is already running.');
  const maxRuns = Math.min(Math.max(Math.trunc(Number(form.get('maxRuns')) || 5), 1), 20);
  const dailyBudget = Math.min(Math.max(Number(form.get('dailyBudget')) || 3, 0.5), 20);
  await startBacklogSession(config, { maxRuns, dailyBudget, requestedBy: login });
  revalidatePath('/backlog');
  redirect('/backlog?started=1');
}

export async function stopSessionAction(form: FormData): Promise<void> {
  const { config } = await owner();
  const runId = Number(form.get('runId'));
  const running = await activeSessions(config);
  if (!running.some((s) => s.id === runId)) throw new Error('That session is not running.');
  await stopSession(config, runId);
  revalidatePath('/backlog');
  redirect('/backlog?stopped=1');
}
