import { describe, expect, it } from 'vitest';
import {
  checkState,
  currentStep,
  type SessionRecord,
  type SiteQueryData,
  type StatusRun,
  sessionProject,
  sessionTally,
  siteState,
  splitSessions,
  statusView,
} from './status-view.ts';

const run = (
  issueNumber: number,
  state: string,
  updatedAt: string,
  id = `run-${issueNumber}`,
): StatusRun => ({
  id,
  repo: 'demo/site',
  issueNumber,
  title: `Issue ${issueNumber}`,
  state,
  implementAttempts: 1,
  spentUsd: 0.1,
  pullRequestUrl: null,
  updatedAt,
});

describe('statusView', () => {
  it('shows a run as current only if it changed since the running session started', () => {
    const view = statusView(
      [run(2, 'Implementing', '2026-11-25T21:05:00.000Z'), run(1, 'Merging', '2026-11-25T20:52:00.000Z')],
      '2026-11-25T21:00:00Z',
    );

    expect(view.current.map((r) => r.issueNumber)).toEqual([2]);
    expect(view.unfinished.map((r) => r.issueNumber)).toEqual([1]);
  });

  it('calls every moving run unfinished when no session is running', () => {
    const view = statusView([run(1, 'Merging', '2026-11-25T20:52:00.000Z')], null);

    expect(view.current).toEqual([]);
    expect(view.unfinished.map((r) => r.issueNumber)).toEqual([1]);
  });

  it('lists finished and held work as outcomes, most recently changed first', () => {
    const view = statusView(
      [
        run(3, 'Reviewing', '2026-11-25T20:10:00.000Z'),
        run(2, 'Merged', '2026-11-25T20:30:00.000Z'),
        run(1, 'Escalated', '2026-11-25T20:20:00.000Z'),
      ],
      null,
    );

    expect(view.outcomes.map((r) => r.issueNumber)).toEqual([2, 1, 3]);
    expect(view.unfinished).toEqual([]);
  });

  it('judges an issue by its latest run, not an earlier one', () => {
    const view = statusView(
      [
        run(1, 'Merged', '2026-11-25T21:00:00.000Z', 'second'),
        run(1, 'Cancelled', '2026-11-25T20:00:00.000Z', 'first'),
      ],
      null,
    );

    expect(view.outcomes.map((r) => r.id)).toEqual(['second']);
  });

  it('separates what the running session finished from what came before it', () => {
    const view = statusView(
      [
        run(3, 'Escalated', '2026-11-25T23:50:00.000Z'),
        run(2, 'Merged', '2026-11-25T23:42:00.000Z'),
        run(1, 'Merged', '2026-11-21T02:36:00.000Z'),
      ],
      '2026-11-25T23:38:04Z',
    );

    expect(view.session.map((r) => r.issueNumber)).toEqual([3, 2]);
    expect(view.outcomes.map((r) => r.issueNumber)).toEqual([1]);
    expect(sessionTally(view.session)).toEqual({ shipped: 1, stopped: 1 });
  });

  it('lists work held for the owner, oldest first, whichever session held it', () => {
    const view = statusView(
      [
        run(3, 'Reviewing', '2026-11-25T23:50:00.000Z'),
        run(2, 'Reviewing', '2026-11-25T23:44:00.000Z'),
        run(1, 'Merged', '2026-11-25T23:42:00.000Z'),
      ],
      null,
    );

    expect(view.held.map((r) => r.issueNumber)).toEqual([2, 3]);
  });

  it('shows a moving run as current when it cannot tell whether a session is running', () => {
    const view = statusView([run(1, 'Gating', '2026-11-25T20:52:00.000Z')], null, { sessionKnown: false });

    expect(view.current.map((r) => r.issueNumber)).toEqual([1]);
    expect(view.unfinished).toEqual([]);
  });
});

describe('sessionProject', () => {
  const started = '2026-11-25T23:38:04Z';

  it('reads the project from the step a backlog session names after it', () => {
    expect(sessionProject(['Install', 'Work through codyalves/brewery (factory:ready)'], [], started)).toBe(
      'codyalves/brewery',
    );
  });

  it('reads the project from the step a single run names after it', () => {
    expect(sessionProject(['Run the factory on demo/site.app#12'], [], started)).toBe('demo/site.app');
  });

  it('falls back to the project of the run that changed most recently since the session started', () => {
    const runs = [
      { ...run(4, 'Merged', '2026-11-21T02:36:00.000Z'), repo: 'demo/old' },
      { ...run(1, 'Merged', '2026-11-25T23:42:00.000Z'), repo: 'demo/site' },
    ];

    expect(sessionProject(['Install'], runs, started)).toBe('demo/site');
  });

  it('does not guess when no step names a project and no run has changed', () => {
    expect(sessionProject(['Install'], [run(1, 'Merged', '2026-11-21T02:36:00.000Z')], started)).toBeNull();
  });
});

describe('sessions', () => {
  const session = (id: number, status: string): SessionRecord => ({
    id,
    workflow: 'factory-backlog',
    status,
    conclusion: status === 'completed' ? 'success' : null,
    url: `https://github.com/demo/factory/actions/runs/${id}`,
    startedAt: '2026-11-25T20:48:05Z',
    updatedAt: '2026-11-25T21:12:18Z',
  });

  it('separates the session holding the slot from the last one that finished', () => {
    const { active, last } = splitSessions([
      session(3, 'queued'),
      session(2, 'completed'),
      session(1, 'completed'),
    ]);

    expect(active?.id).toBe(3);
    expect(last?.id).toBe(2);
  });

  it('reports no active session when all have finished', () => {
    expect(splitSessions([session(2, 'completed')]).active).toBeNull();
  });

  it('names the step a job is on', () => {
    expect(
      currentStep([
        { name: 'Install', status: 'completed' },
        { name: 'Work through demo/site (factory:ready)', status: 'in_progress' },
        { name: 'Summary', status: 'pending' },
      ]),
    ).toBe('Work through demo/site (factory:ready)');
    expect(currentStep([{ name: 'Install', status: 'completed' }])).toBeNull();
  });
});

describe('siteState', () => {
  // The shape GitHub's GraphQL API returned for codyalves/brewery on 2026-11-25.
  const data: SiteQueryData = {
    repository: {
      issues: { totalCount: 6 },
      pullRequests: {
        nodes: [
          {
            number: 8,
            title: 'Card search results page',
            url: 'https://github.com/demo/site/pull/8',
            isDraft: false,
            createdAt: '2026-11-25T20:52:09Z',
            headRefName: 'factory/1-985f4561',
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
          },
        ],
      },
      ref: {
        target: {
          history: {
            nodes: [
              {
                oid: 'a0f82bea4e8041c091c9ee6da006acddc7c0fbb0',
                messageHeadline: 'Start the site',
                committedDate: '2026-11-25T18:31:24Z',
                url: 'https://github.com/demo/site/commit/a0f82bea',
                statusCheckRollup: { state: 'SUCCESS' },
                status: { contexts: [{ context: 'Vercel', state: 'SUCCESS' }] },
                deployments: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  };

  it('reads the deploy from the commit status the host posts', () => {
    const site = siteState(data, 'Vercel');

    expect(site.commits[0]).toMatchObject({ checks: 'success', deploy: 'success' });
    expect(site.pulls[0]).toMatchObject({ number: 8, checks: 'success', branch: 'factory/1-985f4561' });
  });

  it('reports no deploy when the host has posted nothing under that name', () => {
    expect(siteState(data, 'Netlify').commits[0]?.deploy).toBe('none');
  });

  it('prefers a deployment over a commit status when the host reports deployments', () => {
    const commit = data.repository?.ref?.target?.history?.nodes[0];
    if (!commit || !data.repository) throw new Error('fixture has a commit');
    const withDeployment: SiteQueryData = {
      repository: {
        ...data.repository,
        ref: {
          target: {
            history: {
              nodes: [{ ...commit, deployments: { nodes: [{ latestStatus: { state: 'IN_PROGRESS' } }] } }],
            },
          },
        },
      },
    };

    expect(siteState(withDeployment, 'Vercel').commits[0]?.deploy).toBe('pending');
  });

  it('shows nothing, rather than failing, for a repository or branch GitHub does not return', () => {
    expect(siteState({ repository: null }, 'Vercel')).toEqual({ commits: [], pulls: [], readyIssues: 0 });
  });

  it('counts the open issues marked ready', () => {
    expect(siteState(data, 'Vercel').readyIssues).toBe(6);
  });

  it('reduces GitHub states to four', () => {
    expect(['SUCCESS', 'INACTIVE', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', null].map(checkState)).toEqual([
      'success',
      'success',
      'failure',
      'failure',
      'pending',
      'pending',
      'none',
    ]);
  });
});
