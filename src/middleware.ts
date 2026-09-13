/**
 * Edge gate for product surfaces.
 *
 * API project routes still enforce requireAuth + ownership in-handler
 * (the source of truth). This middleware only redirects unauthenticated
 * browsers away from the account/workspace shell when auth is required,
 * and keeps marketing pages open.
 */

import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'wireup_session';

const PROTECTED_PAGE_PREFIXES = ['/account', '/project'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Never block auth endpoints or static assets (matcher already excludes most).
  if (pathname.startsWith('/api/auth') || pathname.startsWith('/api/billing/webhook')) {
    return NextResponse.next();
  }

  const authRequired = (process.env.WIREUP_AUTH_REQUIRED ?? 'true').toLowerCase() !== 'false';
  if (!authRequired) return NextResponse.next();

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (isProtectedPage && !hasSession) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  // Soft hint for API clients: project APIs still do real auth in-handler.
  if (pathname.startsWith('/api/projects') && !hasSession) {
    const authHeader = request.headers.get('authorization') ?? '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      // Let the route return a structured 401 JSON (do not short-circuit here)
      // so API clients get consistent error shapes from requireAuth.
      return NextResponse.next();
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/account/:path*', '/project/:path*', '/api/projects/:path*'],
};
