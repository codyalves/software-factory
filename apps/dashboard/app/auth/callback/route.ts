import { type NextRequest, NextResponse } from 'next/server';
import { controlConfig } from '@/lib/control';
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, SESSION_TTL_MS, sameState, signSession } from '@/lib/session';

/**
 * GitHub sends the visitor back here. The code is exchanged for a token only
 * to learn who signed in; the token is not kept.
 */
export async function GET(request: NextRequest) {
  const config = controlConfig();
  if (!config) return new NextResponse('Sign-in is not set up for this dashboard.', { status: 404 });

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  if (!code || !sameState(request.cookies.get(OAUTH_STATE_COOKIE)?.value, state)) {
    return new NextResponse('That sign-in link expired or was not started here. Sign in again.', {
      status: 400,
    });
  }

  const exchange = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: new URL('/auth/callback', request.nextUrl.origin).href,
    }),
  });
  const { access_token: token } = (await exchange.json()) as { access_token?: string };
  if (!token) return new NextResponse('GitHub did not confirm the sign-in. Sign in again.', { status: 400 });

  const user = await fetch('https://api.github.com/user', {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
  });
  const { login } = (await user.json()) as { login?: string };
  if (!user.ok || !login) return new NextResponse('GitHub did not say who signed in.', { status: 502 });

  const response = NextResponse.redirect(new URL('/backlog', request.nextUrl.origin));
  response.cookies.delete({ name: OAUTH_STATE_COOKIE, path: '/auth' });
  response.cookies.set(SESSION_COOKIE, signSession(login, config.sessionSecret, Date.now()), {
    httpOnly: true,
    secure: request.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  return response;
}
