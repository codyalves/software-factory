'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  activeSessions,
  approveHeldRun,
  controlConfig,
  currentOwner,
  currentProject,
  fileIssue,
  openTargetIssues,
  repoConventions,
  startBacklogSession,
  stopSession,
} from '@/lib/control';
import { reports } from '@/lib/data';
import { checkPlan, dependsOnFor, fileable, type Plan, type PlannedDraftCheck, parsePlan } from '@/lib/plan';
import { draftPlan } from '@/lib/planner';
import { PROJECT_COOKIE } from '@/lib/projects';
import { vagueCriteria } from '@/lib/request-check';
import { requestDraft } from '@/lib/requests';
import { specCheck } from '@/lib/spec-check';

/**
 * Every action re-checks, on the server, that an owner is signed in: hiding
 * a button is not access control. Each one acts through GitHub as the
 * factory's App; GitHub and the factory's audit log record what happened.
 */
async function owner() {
  const config = controlConfig();
  const login = await currentOwner();
  if (!config || !login) throw new Error('Only a signed-in owner can do that.');
  return { config, login, repo: await currentProject(config) };
}

/** The home screen and the fuller pages share these actions; each returns you to where you pressed. */
function fromHome(form: FormData): boolean {
  return form.get('from') === 'home';
}

export interface RequestFormState {
  readonly error: string | null;
  /** Criteria the free check found too vague to test, and why. */
  readonly vague?: readonly { readonly criterion: string; readonly why: string }[];
  /** True when the owner may tick "File anyway" to overrule the checks. */
  readonly canOverride?: boolean;
  /** What was typed, so a refused request comes back filled in. */
  readonly values: Readonly<Record<'title' | 'description' | 'criteria' | 'dependsOn', string>>;
}

export async function fileRequestAction(
  _previous: RequestFormState,
  form: FormData,
): Promise<RequestFormState> {
  const { config, login, repo } = await owner();
  const values = {
    title: String(form.get('title') ?? ''),
    description: String(form.get('description') ?? ''),
    criteria: String(form.get('criteria') ?? ''),
    dependsOn: String(form.get('dependsOn') ?? ''),
  };
  const draft = requestDraft({ ...values, requestedBy: login });
  if (!draft.ok) return { error: draft.error, values };

  // Catch what triage would stop on before filing, not after a session.
  // The owner can overrule it; triage still has the last word.
  if (form.get('override') !== 'on') {
    const criteria = values.criteria
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
      .filter(Boolean);
    const vague = vagueCriteria(criteria);
    if (vague.length > 0) {
      return {
        error: 'Some criteria cannot be checked by a test yet. Triage would stop on these:',
        vague,
        canOverride: true,
        values,
      };
    }
    const spec = await specCheck(repo, draft.title, draft.body).catch(() => null);
    if (spec && !spec.ready) {
      return {
        error: `Triage's spec check says this is not ready to build (${Math.round(spec.probability * 100)}% confident). Make each criterion something a test can check: what is shown or what happens, where, and when.`,
        canOverride: true,
        values,
      };
    }
  }
  const issue = await fileIssue(config, repo, draft);
  revalidatePath('/backlog');
  redirect(`/backlog?filed=${issue.number}`);
}

export async function startSessionAction(form: FormData): Promise<void> {
  const { config, login, repo } = await owner();
  if ((await activeSessions(config)).length > 0) throw new Error('A factory session is already running.');
  const maxRuns = Math.min(Math.max(Math.trunc(Number(form.get('maxRuns')) || 5), 1), 20);
  const dailyBudget = Math.min(Math.max(Number(form.get('dailyBudget')) || 3, 0.5), 20);
  await startBacklogSession(config, repo, { maxRuns, dailyBudget, requestedBy: login });
  revalidatePath('/backlog');
  redirect(`${fromHome(form) ? '/' : '/backlog'}?started=1`);
}

export async function stopSessionAction(form: FormData): Promise<void> {
  const { config } = await owner();
  const runId = Number(form.get('runId'));
  const running = await activeSessions(config);
  if (!running.some((s) => s.id === runId)) throw new Error('That session is not running.');
  await stopSession(config, runId);
  revalidatePath('/backlog');
  redirect(`${fromHome(form) ? '/' : '/backlog'}?stopped=1`);
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Approves a run that was held for the owner. The record must say it is held
 * (so a stale page cannot approve something else), and the approval itself is
 * recorded by the factory, with this owner's login, when the workflow runs.
 */
export async function approveRunAction(form: FormData): Promise<void> {
  const { config, login } = await owner();
  const runId = String(form.get('runId') ?? '');
  if (!RUN_ID.test(runId)) throw new Error('That is not a run.');
  const run = await reports().runReport(runId);
  if (run?.state !== 'Reviewing') throw new Error('That run is not held for review.');
  await approveHeldRun(config, { runId, requestedBy: login });
  revalidatePath('/status');
  redirect(`${fromHome(form) ? '/' : '/status'}?approved=${run.issueNumber}`);
}

/** Switching projects only changes what the workspace shows, so anyone may do it. */
export async function setProjectAction(form: FormData): Promise<void> {
  const config = controlConfig();
  const project = String(form.get('project') ?? '');
  if (config?.projects.includes(project)) {
    (await cookies()).set(PROJECT_COOKIE, project, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  const back = String(form.get('back') ?? '/');
  redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/');
}

export interface PlanState {
  readonly request: string;
  readonly plan: Plan | null;
  readonly checks: readonly PlannedDraftCheck[];
  readonly error: string | null;
  /** What drafting this plan cost. */
  readonly usd?: number;
  /** Issues filed before a failure, so nothing is filed twice. */
  readonly filed?: readonly number[];
}

/** Drafts a plan for review. Nothing is filed: the owner edits it first. */
export async function draftPlanAction(_previous: PlanState, form: FormData): Promise<PlanState> {
  const { config, repo } = await owner();
  const request = String(form.get('request') ?? '').trim();
  const empty = { request, plan: null, checks: [] };
  if (request.length < 20) {
    return { ...empty, error: 'Describe what the site should do in a sentence or more.' };
  }
  if (request.length > 4_000) return { ...empty, error: 'Keep the request under 4,000 characters.' };
  if (request.includes('<!--')) return { ...empty, error: 'HTML comments are not allowed in a request.' };

  const [conventions, issues] = await Promise.all([
    repoConventions(config, repo),
    openTargetIssues(config, repo).catch(() => []),
  ]);
  const result = await draftPlan({
    repo,
    request,
    conventions,
    openIssues: issues.map((i) => ({ number: i.number, title: i.title })),
  });
  if (!result.ok) return { ...empty, error: result.error };
  return { request, plan: result.plan, checks: checkPlan(result.plan), error: null, usd: result.usd };
}

/**
 * Files an edited plan as issues, in order, each through the request form's
 * own rules, with later issues depending on the numbers earlier ones got.
 */
export async function filePlanAction(previous: PlanState, form: FormData): Promise<PlanState> {
  const { config, login, repo } = await owner();
  if (form.get('repo') !== repo) {
    return {
      ...previous,
      error: `The project changed to ${repo} since this plan was drafted. Switch back to file it.`,
    };
  }
  const plan = parsePlan(String(form.get('plan') ?? ''));
  if (!plan) return { ...previous, error: 'The plan could not be read. Draft it again.' };
  const checks = checkPlan(plan);
  if (!fileable(checks)) {
    return { ...previous, plan, checks, error: 'Fix the issues marked below, then file the plan.' };
  }

  const filed: number[] = [];
  for (const issue of plan.issues) {
    const draft = requestDraft({
      title: issue.title,
      description: issue.description,
      criteria: issue.criteria.join('\n'),
      dependsOn: dependsOnFor(issue, filed),
      requestedBy: login,
    });
    if (!draft.ok) return { ...previous, plan, checks, filed, error: draft.error };
    try {
      filed.push((await fileIssue(config, repo, draft)).number);
    } catch (error) {
      return {
        ...previous,
        plan,
        checks,
        filed,
        error: `GitHub refused issue ${filed.length + 1} of the plan (${(error as Error).message}). ${
          filed.length > 0 ? `Already filed: ${filed.map((n) => `#${n}`).join(', ')}.` : 'Nothing was filed.'
        }`,
      };
    }
  }
  revalidatePath('/backlog');
  // A plan is drafted and filed on the home screen, so that is where it lands.
  redirect(`/?planned=${filed.join(',')}`);
}
