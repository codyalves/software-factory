import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

export function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/', request.nextUrl.origin), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
