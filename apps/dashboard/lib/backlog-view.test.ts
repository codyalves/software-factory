import type { BacklogIssue } from '@factory/domain';
import { describe, expect, it } from 'vitest';
import { backlogView, type LatestRun } from './backlog-view.ts';

const issue = (number: number, body = '', labels = ['factory:ready']): BacklogIssue => ({
  number,
  title: `Issue ${number}`,
  body,
  labels,
});
const run = (state: string): LatestRun => ({ id: `run-${state}`, state, pullRequestUrl: null });

describe('backlogView', () => {
  it('orders the queue so dependents follow what they wait on', () => {
    const view = backlogView(
      [issue(22, 'Depends on #21'), issue(21, 'Depends on #20'), issue(20)],
      new Map(),
    );

    expect(view.next.map((r) => r.number)).toEqual([20, 21, 22]);
    expect(view.blocked).toEqual([]);
  });

  it('shows what is blocked on an issue outside the queue, and on which', () => {
    const view = backlogView([issue(9, 'Depends on #5'), issue(5, '', ['someday'])], new Map());

    expect(view.next).toEqual([]);
    expect(view.blocked.map((b) => [b.number, b.on])).toEqual([[9, [5]]]);
  });

  it("puts held and handed-over work in the owner's queue, and active work under running", () => {
    const view = backlogView(
      [issue(21), issue(30, '', ['needs-owner']), issue(31), issue(22, 'Depends on #21')],
      new Map([
        [21, run('Reviewing')],
        [31, run('Implementing')],
      ]),
    );

    expect(view.owner.map((r) => r.number)).toEqual([21, 30]);
    expect(view.running.map((r) => r.number)).toEqual([31]);
    expect(view.blocked.map((b) => [b.number, b.on])).toEqual([[22, [21]]]);
  });
});
