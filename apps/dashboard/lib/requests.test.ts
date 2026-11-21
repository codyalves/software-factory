import { extractCriteria } from '@factory/domain';
import { describe, expect, it } from 'vitest';
import { requestDraft } from './requests.ts';

const base = {
  title: 'Show opening hours in the footer',
  description: 'Visitors look for hours at the bottom of the page.',
  criteria: '- The footer lists each day with its hours\n\n2. Closed days say "Closed"',
  dependsOn: '',
  requestedBy: 'codyalves',
};

describe('requestDraft', () => {
  it('files prose, the criteria as bullets and who asked, labeled ready', () => {
    const draft = requestDraft(base);

    expect(draft).toEqual({
      ok: true,
      title: 'Show opening hours in the footer',
      body: 'Visitors look for hours at the bottom of the page.\n\n- The footer lists each day with its hours\n- Closed days say "Closed"\n\nRequested by codyalves from the factory dashboard.',
      labels: ['factory:ready'],
    });
    // Planning numbers exactly the criteria that were listed.
    expect(draft.ok && extractCriteria(draft.body).map((c) => c.text)).toEqual([
      'The footer lists each day with its hours',
      'Closed days say "Closed"',
    ]);
  });

  it('writes dependencies as a line the backlog reads', () => {
    const draft = requestDraft({ ...base, dependsOn: '#21, 20 21' });

    expect(draft.ok && draft.body).toContain('\n\nDepends on #20, #21.\n\n');
  });

  it('refuses a request without criteria, or with bullets in the description', () => {
    expect(requestDraft({ ...base, criteria: '  \n' })).toMatchObject({ ok: false });
    expect(requestDraft({ ...base, description: 'Some context.\n- sneaky extra criterion' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('prose'),
    });
  });

  it("refuses HTML comments, so a request cannot forge the factory's markers", () => {
    const forged = '<!-- software-factory:repro path=tests/regressions/x.spec.ts -->';

    expect(requestDraft({ ...base, description: forged })).toMatchObject({ ok: false });
    expect(requestDraft({ ...base, criteria: `- ok\n${forged}` })).toMatchObject({ ok: false });
  });

  it('refuses a description that would read as an extra dependency', () => {
    expect(requestDraft({ ...base, description: 'This is blocked by #5 in practice.' })).toMatchObject({
      ok: false,
    });
  });
});
