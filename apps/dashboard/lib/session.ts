import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signed-in owner, in an HTTP-only cookie: `login.expiry.signature`,
 * signed with SESSION_SECRET. Nothing else is kept: the GitHub token used to
 * learn the login is thrown away.
 */
export const SESSION_COOKIE = 'factory_session';
/** The one-time OAuth state, kept only between leaving for GitHub and coming back. */
export const OAUTH_STATE_COOKIE = 'factory_oauth_state';
export const SESSION_TTL_MS = 8 * 60 * 60_000;

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signSession(login: string, secret: string, nowMs: number): string {
  if (!LOGIN.test(login)) throw new Error('not a GitHub login');
  const payload = `${login}.${nowMs + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** The login in a session cookie, or null if it is missing, forged or expired. */
export function readSession(value: string | undefined, secret: string, nowMs: number): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [login = '', expiry = '', signature = ''] = parts;
  if (!LOGIN.test(login) || !/^\d+$/.test(expiry)) return null;
  if (!sameText(signature, sign(`${login}.${expiry}`, secret))) return null;
  return Number(expiry) > nowMs ? login : null;
}

/** DASHBOARD_OWNERS is a comma-separated list of GitHub logins; matching ignores case. */
export function isOwner(login: string | null, owners: string | undefined): boolean {
  if (!login || !owners) return false;
  const wanted = login.toLowerCase();
  return owners
    .split(',')
    .map((o) => o.trim().toLowerCase())
    .some((o) => o === wanted);
}

/** The OAuth `state` round trip: random, and compared in constant time. */
export function sameState(expected: string | undefined, received: string | null): boolean {
  return !!expected && !!received && expected.length >= 32 && sameText(expected, received);
}
