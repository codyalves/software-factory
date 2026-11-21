import { describe, expect, it } from 'vitest';
import { isOwner, readSession, SESSION_TTL_MS, sameState, signSession } from './session.ts';

const SECRET = 'a-session-secret-that-is-long-enough-1234';
const NOW = 1_800_000_000_000;

describe('sessions', () => {
  it('reads back the login it signed until the session expires', () => {
    const cookie = signSession('codyalves', SECRET, NOW);

    expect(readSession(cookie, SECRET, NOW + 1)).toBe('codyalves');
    expect(readSession(cookie, SECRET, NOW + SESSION_TTL_MS + 1)).toBeNull();
  });

  it('refuses a session signed with another secret, or edited to name someone else', () => {
    const cookie = signSession('codyalves', SECRET, NOW);
    const [, expiry, signature] = cookie.split('.');

    expect(readSession(cookie, 'another-secret-entirely-0000000000', NOW)).toBeNull();
    expect(readSession(`someone-else.${expiry}.${signature}`, SECRET, NOW)).toBeNull();
    expect(readSession('garbage', SECRET, NOW)).toBeNull();
    expect(readSession(undefined, SECRET, NOW)).toBeNull();
  });

  it('only signs real GitHub logins', () => {
    expect(() => signSession('a.b', SECRET, NOW)).toThrow();
  });
});

describe('owners', () => {
  it('lets only listed logins act, ignoring case and spaces', () => {
    expect(isOwner('CodyAlves', 'someone, codyalves')).toBe(true);
    expect(isOwner('mallory', 'codyalves')).toBe(false);
    expect(isOwner('codyalves', undefined)).toBe(false);
    expect(isOwner(null, 'codyalves')).toBe(false);
  });
});

describe('OAuth state', () => {
  it('matches only the long random value it set', () => {
    const state = 'x'.repeat(43);

    expect(sameState(state, state)).toBe(true);
    expect(sameState(state, `${state}y`)).toBe(false);
    expect(sameState(undefined, state)).toBe(false);
    expect(sameState('short', 'short')).toBe(false);
  });
});
