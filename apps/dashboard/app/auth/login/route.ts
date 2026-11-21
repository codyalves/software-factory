import { type NextRequest, NextResponse } from 'next/server';
import { controlConfig, newOAuthState } from '@/lib/control';
import { OAUTH_STATE_COOKIE } from '@/lib/session';

/** Sends the visitor to GitHub to sign in, with a one-time state to check on the way back. */
export function GET(request: NextRequest) {
  const config = controlConfig();
  if (!config) {
    return new NextResponse('Sign-in is not set up for this dashboard (see docs/dashboard.md).', {
      status: 404,
    });
  }
  const state = newOAuthState();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', new URL('/auth/callback', request.nextUrl.origin).href);
  authorize.searchParams.set('state', state);

  const response = NextResponse.redirect(authorize);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: request.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: '/auth',
    maxAge: 600,
  });
  return response;
}
