import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * SiteSentra — request proxy (Next.js 16).
 *
 * This file replaces the legacy `src/middleware.ts`. Next.js 16 introduced
 * `proxy.ts` as the preferred entry-point; the old `middleware.ts` name is
 * preserved for backwards compatibility but the framework now resolves
 * `proxy.ts` first during the build analysis phase (see
 * `node_modules/next/dist/esm/lib/constants.js` → `PROXY_FILENAME`).
 *
 * SECURITY LIMITATION — cookie-based auth, NOT session validation:
 *   This proxy reads the `ss_session` cookie directly and treats its mere
 *   presence as a *hint* that the user may be authenticated. It does NOT
 *   verify the token against the database. Therefore:
 *     - A revoked or expired session cookie still passes this proxy.
 *     - A forged cookie also passes (until the API or server component
 *       validates it against Neon).
 *   Authoritative identity is established ONLY by `getCurrentUser()` and
 *   `requireUserOrRedirect()` in `src/lib/auth/session.ts`, which query the
 *   database, check `revokedAt` and `expiresAt`, and return null when invalid.
 *   Every protected API route and server component calls one of these
 *   functions before acting on behalf of a user.
 *
 * Job:
 *  1. Optimistically redirect unauthenticated users away from `/dashboard/*`
 *     so the server component path is short-circuited before rendering begins.
 *  2. Optimistically redirect authenticated users away from `/login` and
 *     `/signup` (avoid duplicate session creation).
 *  3. Add security headers that the framework-level CSP in next.config.ts
 *     does not cover (the single source of truth for CSP is next.config.ts).
 */

const DASHBOARD_PREFIX = "/dashboard";
const LOGIN_PATH = "/login";
const SIGNUP_PATH = "/signup";

function isDashboardPath(pathname: string): boolean {
  return pathname === DASHBOARD_PREFIX || pathname.startsWith(`${DASHBOARD_PREFIX}/`);
}

function isAuthPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname === SIGNUP_PATH;
}

/**
 * Named export `proxy` is the convention Next.js 16 expects for this file.
 * The framework resolves it at build time via PROXY_FILENAME = 'proxy'.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Read the session cookie without a DB round-trip. Presence is an
  // optimistic hint, NOT proof of a valid session.
  const sessionCookie = request.cookies.get("ss_session");
  const hasSessionCookie = sessionCookie !== undefined && sessionCookie.value.length > 0;

  // Only redirect UNAUTHENTICATED users away from protected paths.
  // Do NOT redirect from /login or /signup based on cookie presence,
  // because the cookie may be expired, revoked, or invalid.
  // Server Components (getCurrentUser/requireUserOrRedirect) perform
  // authoritative validation and handle the "already signed in" case.
  if (isDashboardPath(pathname) && !hasSessionCookie) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Security headers — single source of truth for CSP is next.config.ts.
  // These cover headers that next.config.ts does not emit.
  const response = NextResponse.next();
  response.headers.set("X-DNS-Prefetch-Control", "off");

  return response;
}

export const config = {
  // Match every route except static assets, images, favicon, and the health check.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
