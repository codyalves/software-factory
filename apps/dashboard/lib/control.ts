import { randomBytes } from 'node:crypto';
import { type ForgeIssue, READY_LABEL } from '@factory/domain';
import { GitHubAppAuth, GitHubForge, githubRequest, parsePrivateKey } from '@factory/github';
import { cookies } from 'next/headers';
import { reports } from './data';
import { PROJECT_COOKIE, pickProject, projectList } from './projects';
import { isOwner, readSession, SESSION_COOKIE } from './session';
import {
  currentStep,
  type SessionRecord,
  type SiteQueryData,
  type SiteState,
  siteState,
} from './status-view';
import type { TargetSite } from './targets';

/**
 * The control panel's link to GitHub, as the factory's own App. Every action
 * goes through GitHub (issues, workflow runs), never into the database: the
 * dashboard's database login stays read-only, and the orchestrator stays the
 * only writer of run state.
 */
export interface ControlConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly owners: string;
  readonly factoryRepo: string;
  /** The target repositories the factory builds; the first is the default project. */
  readonly projects: readonly string[];
}

/** Null until every setting is present (docs/dashboard.md); the panel then stays read-only. */
export function controlConfig(): ControlConfig | null {
  const env = process.env;
  const config = {
    appId: env.GITHUB_APP_ID ?? '',
    privateKey: env.GITHUB_APP_PRIVATE_KEY ?? '',
    clientId: env.GITHUB_APP_CLIENT_ID ?? '',
    clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    owners: env.DASHBOARD_OWNERS ?? '',
    factoryRepo: env.FACTORY_REPO || 'codyalves/software-factory',
    projects: projectList(env.TARGET_REPOS || env.TARGET_REPO || 'codyalves/factory-target-app'),
  };
  const complete =
    config.appId && config.privateKey && config.clientId && config.clientSecret && config.owners;
  return complete && config.sessionSecret.length >= 32 && config.projects.length > 0 ? config : null;
}

/** The project the owner picked in the switcher, if it is still one of the projects. */
export async function currentProject(config: ControlConfig): Promise<string> {
  return pickProject(config.projects, (await cookies()).get(PROJECT_COOKIE)?.value);
}

/** The signed-in GitHub login, if any. */
export async function currentLogin(): Promise<string | null> {
  const config = controlConfig();
  if (!config) return null;
  return readSession((await cookies()).get(SESSION_COOKIE)?.value, config.sessionSecret, Date.now());
}

/** The signed-in login if it may take actions; checked on the server for every action. */
export async function currentOwner(): Promise<string | null> {
  const login = await currentLogin();
  return isOwner(login, controlConfig()?.owners) ? login : null;
}

export function newOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

const cache = globalThis as { factoryAppAuth?: GitHubAppAuth };

function appAuth(config: ControlConfig): GitHubAppAuth {
  // Vercel keeps a pasted PEM's line breaks; a one-line value with \n also works.
  cache.factoryAppAuth ??= new GitHubAppAuth({
    appId: config.appId,
    privateKey: parsePrivateKey(config.privateKey.replace(/\\n/g, '\n')),
  });
  return cache.factoryAppAuth;
}

async function appRequest(config: ControlConfig, repo: string) {
  return {
    fetch: globalThis.fetch,
    baseUrl: 'https://api.github.com',
    token: await appAuth(config).tokenFor(repo),
  };
}

export async function openTargetIssues(config: ControlConfig, repo: string): Promise<ForgeIssue[]> {
  return new GitHubForge({ auth: appAuth(config) }).openIssues(repo);
}

export async function fileIssue(
  config: ControlConfig,
  repo: string,
  draft: { title: string; body: string; labels: string[] },
): Promise<{ number: number; url: string }> {
  const request = await appRequest(config, repo);
  const created = await githubRequest<{ number: number; html_url: string }>(
    request,
    'POST',
    `/repos/${repo}/issues`,
    draft,
  );
  return { number: created.number, url: created.html_url };
}

/** A target's CLAUDE.md on its default branch, so the planner follows its conventions. */
export async function repoConventions(config: ControlConfig, repo: string): Promise<string | null> {
  try {
    const request = await appRequest(config, repo);
    const file = await githubRequest<{ content: string; encoding: string }>(
      request,
      'GET',
      `/repos/${repo}/contents/CLAUDE.md`,
    );
    return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  } catch {
    return null;
  }
}

export interface Session {
  readonly id: number;
  readonly workflow: string;
  readonly status: string;
  readonly url: string;
  readonly startedAt: string;
}

/** The workflows that share the factory's one slot: sessions, single runs and approvals. */
const FACTORY_WORKFLOWS: readonly string[] = ['factory-backlog', 'factory-run', 'factory-approve'];

/** Factory sessions queued or running now. They share one slot. */
export async function activeSessions(config: ControlConfig): Promise<Session[]> {
  const request = await appRequest(config, config.factoryRepo);
  const found: Session[] = [];
  for (const status of ['in_progress', 'queued'] as const) {
    const { workflow_runs: runs } = await githubRequest<{
      workflow_runs: { id: number; name: string; status: string; html_url: string; run_started_at: string }[];
    }>(request, 'GET', `/repos/${config.factoryRepo}/actions/runs?status=${status}&per_page=20`);
    for (const r of runs) {
      if (FACTORY_WORKFLOWS.includes(r.name)) {
        found.push({
          id: r.id,
          workflow: r.name,
          status: r.status,
          url: r.html_url,
          startedAt: r.run_started_at,
        });
      }
    }
  }
  return found;
}

/** The latest factory sessions, running or finished, newest first. One call, for the status page. */
export async function recentSessions(config: ControlConfig): Promise<SessionRecord[]> {
  const request = await appRequest(config, config.factoryRepo);
  const { workflow_runs: runs } = await githubRequest<{
    workflow_runs: {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      run_started_at: string;
      updated_at: string;
    }[];
  }>(request, 'GET', `/repos/${config.factoryRepo}/actions/runs?per_page=100`);
  return runs
    .filter((r) => FACTORY_WORKFLOWS.includes(r.name))
    .map((r) => ({
      id: r.id,
      workflow: r.name,
      status: r.status,
      conclusion: r.conclusion,
      url: r.html_url,
      startedAt: r.run_started_at,
      updatedAt: r.updated_at,
    }));
}

/** The names of a session's steps, and the one it is on now (null between steps or once done). */
export async function sessionSteps(
  config: ControlConfig,
  runId: number,
): Promise<{ names: string[]; current: string | null }> {
  const request = await appRequest(config, config.factoryRepo);
  const { jobs } = await githubRequest<{ jobs: { steps?: { name: string; status: string }[] }[] }>(
    request,
    'GET',
    `/repos/${config.factoryRepo}/actions/runs/${runId}/jobs?per_page=10`,
  );
  const steps = jobs.flatMap((j) => j.steps ?? []);
  return { names: steps.map((s) => s.name), current: currentStep(steps) };
}

// One call for everything the status page shows about the target: how many
// issues are ready, open pull requests with their checks, and the base
// branch's latest commits with their
// checks and production deploy (as a deployment or as a commit status).
const SITE_QUERY = `
query($owner: String!, $name: String!, $branch: String!, $environment: String!, $ready: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, labels: [$ready]) { totalCount }
    pullRequests(states: OPEN, first: 20, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft createdAt headRefName
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    ref(qualifiedName: $branch) {
      target {
        ... on Commit {
          history(first: 5) {
            nodes {
              oid messageHeadline committedDate url
              statusCheckRollup { state }
              status { contexts { context state } }
              deployments(environments: [$environment], first: 1) { nodes { latestStatus { state } } }
            }
          }
        }
      }
    }
  }
}`;

/** The target's open pull requests and latest commits, with checks and production deploys. */
export async function readSite(config: ControlConfig, repo: string, site: TargetSite): Promise<SiteState> {
  const [owner, name] = repo.split('/');
  const response = await githubRequest<{ data?: SiteQueryData; errors?: { message: string }[] }>(
    await appRequest(config, repo),
    'POST',
    '/graphql',
    {
      query: SITE_QUERY,
      variables: {
        owner,
        name,
        branch: `refs/heads/${site.baseBranch}`,
        environment: site.production?.environment ?? 'Production',
        ready: READY_LABEL,
      },
    },
  );
  if (!response.data) {
    throw new Error(response.errors?.map((e) => e.message).join('; ') || 'GitHub returned no data');
  }
  return siteState(response.data, site.production?.statusContext ?? 'Vercel');
}

export async function startBacklogSession(
  config: ControlConfig,
  repo: string,
  input: { maxRuns: number; dailyBudget: number; requestedBy: string },
): Promise<void> {
  const request = await appRequest(config, config.factoryRepo);
  await githubRequest(
    request,
    'POST',
    `/repos/${config.factoryRepo}/actions/workflows/factory-backlog.yml/dispatches`,
    {
      ref: 'main',
      inputs: {
        repo,
        max_runs: String(input.maxRuns),
        daily_budget: String(input.dailyBudget),
        requested_by: input.requestedBy,
      },
    },
  );
}

/**
 * Approves a run held for the owner. Like every action it goes through
 * GitHub: the factory-approve workflow records the approval in the audit log
 * and ships the run, so the dashboard still writes nothing to the database.
 */
export async function approveHeldRun(
  config: ControlConfig,
  input: { runId: string; requestedBy: string },
): Promise<void> {
  const request = await appRequest(config, config.factoryRepo);
  await githubRequest(
    request,
    'POST',
    `/repos/${config.factoryRepo}/actions/workflows/factory-approve.yml/dispatches`,
    { ref: 'main', inputs: { run_id: input.runId, requested_by: input.requestedBy } },
  );
}

export async function stopSession(config: ControlConfig, runId: number): Promise<void> {
  const request = await appRequest(config, config.factoryRepo);
  await githubRequest(request, 'POST', `/repos/${config.factoryRepo}/actions/runs/${runId}/cancel`);
}

/** The latest run for each issue of the target, newest first in the record. */
export async function latestRunsByIssue(targetRepo: string) {
  const runs = await reports().listRuns({ limit: 500 });
  const latest = new Map<number, { id: string; state: string; pullRequestUrl: string | null }>();
  for (const r of runs) {
    if (r.repo === targetRepo && !latest.has(r.issueNumber)) {
      latest.set(r.issueNumber, { id: r.id, state: r.state, pullRequestUrl: r.pullRequestUrl });
    }
  }
  return latest;
}
