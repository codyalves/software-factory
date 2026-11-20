import { describe, expect, it } from 'vitest';
import { type BacklogIssue, dependencies, nextFromBacklog, READY_LABEL } from './backlog.ts';

const issue = (number: number, body = '', labels = [READY_LABEL]): BacklogIssue => ({
  number,
  title: `Issue ${number}`,
  body,
  labels,
});

describe('dependencies', () => {
  it('reads "depends on", "blocked by" and "after" lines, with one or more issues', () => {
    expect(dependencies('Depends on #6.\n\n- AC one')).toEqual([6]);
    expect(dependencies('Blocked by #3 and #4')).toEqual([3, 4]);
    expect(dependencies('Do this after #10, #2')).toEqual([2, 10]);
  });

  it('ignores issue references that are not dependencies', () => {
    expect(dependencies('Like #5, but for the footer.\n- See #7 for context')).toEqual([]);
  });
});

describe('nextFromBacklog', () => {
  it('takes the oldest ready issue whose dependencies are closed', () => {
    const choice = nextFromBacklog([issue(9), issue(8, 'Depends on #6')], new Set([8, 9]));

    expect(choice.next?.number).toBe(8);
  });

  it('skips an issue waiting on an open one, and says which', () => {
    const choice = nextFromBacklog(
      [issue(7, 'Depends on #6'), issue(9, 'Depends on #7')],
      new Set([6, 7, 9]),
    );

    expect(choice.next).toBeNull();
    expect(choice.blocked).toEqual([
      { number: 7, on: [6] },
      { number: 9, on: [7] },
    ]);
  });

  it('only takes ready, open issues this session has not tried', () => {
    const issues = [issue(3, '', ['bug']), issue(4), issue(5), issue(6)];

    expect(nextFromBacklog(issues, new Set([3, 4, 5]), new Set([4]))?.next?.number).toBe(5);
  });
});
