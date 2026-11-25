import { describe, expect, it } from 'vitest';
import {
  checkState,
  currentStep,
  type SessionRecord,
  type SiteQueryData,
  type StatusRun,
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
    expect(siteState({ repository: null }, 'Vercel')).toEqual({ commits: [], pulls: [] });
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
