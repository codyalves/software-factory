import { describe, expect, it } from 'vitest';
import { vagueCriteria } from './request-check.ts';

describe('vagueCriteria', () => {
  it('flags judgments, "exists" and short lines, saying why', () => {
    const found = vagueCriteria([
      'The chatbot UI/UX is improved and matches newest styling options',
      'Menu exists and is navigable',
      'Looks good',
    ]);

    expect(found.map((f) => f.why.split('"')[1] ?? f.why)).toEqual([
      'improved',
      'exists',
      'Too short to test. Say what is shown or what happens, and where.',
    ]);
  });

  it('passes criteria a test can check', () => {
    expect(
      vagueCriteria([
        'A round button fixed to the bottom-right corner, named "Ask us a question", opens the chat in a panel',
        'Prices show in US dollars with two decimals, such as "$4.00"',
        'Pressing Escape closes the open menu and returns focus to the Menu button',
      ]),
    ).toEqual([]);
  });

  it('lets a number make a speed or size checkable', () => {
    expect(vagueCriteria(['The page is fast'])).toHaveLength(1);
    expect(vagueCriteria(['The home page loads within 2 seconds on a phone'])).toEqual([]);
  });
});
