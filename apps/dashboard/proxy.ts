import { type NextRequest, NextResponse } from 'next/server';

/**
 * Optional password protection. With DASHBOARD_PASSWORD set, every page asks
 * for it (HTTP basic auth, any user name). Without it the dashboard is open,
 * which is fine locally and for a public demo, since it only reads.
 */
export function proxy(request: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const header = request.headers.get('authorization') ?? '';
  const supplied = header.startsWith('Basic ') ? decode(header.slice(6)) : null;
  if (supplied !== null && sameText(supplied.slice(supplied.indexOf(':') + 1), password)) {
    return NextResponse.next();
  }
  return new NextResponse('The factory dashboard needs a password.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Software factory", charset="UTF-8"' },
  });
}

function decode(base64: string): string | null {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Compares in time that does not depend on where the strings differ. */
function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const config = { matcher: '/((?!_next/static|_next/image|favicon.ico).*)' };
