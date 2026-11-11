/**
 * SiteSentra — server-side session management.
 *
 * Why this exists (and why it is NOT in client code):
 *  - The session cookie holds an opaque 256-bit random token. Only its SHA-256
 *    digest is stored in the database, so a leaked database does not hand out
 *    working sessions.
 *  - Identity is ALWAYS derived here, from the cookie, on the server. No route
 *    or query is allowed to supply a user id.
 *  - Cookies are HttpOnly (unreadable by JavaScript → XSS cannot steal them),
 *    SameSite=Lax (blocks cross-site POST forgery), Secure whenever the request
 *    arrived over HTTPS, and scoped to `/`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { db } from "../../db/index.ts";
import { sessions, users, type User } from "../../db/schema.ts";
import { generateSessionToken, hashToken, newId, safeRedirectPath } from "./password.ts";
import { isSameOriginMutationRequest, isTrustedMutationRequest } from "./origin-policy.ts";

export const SESSION_COOKIE = "ss_session";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SessionCookie = { value: string };
export type SessionCookieStore = {
  get(name: string): SessionCookie | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): void;
  delete(name: string): void;
};

export type SessionRequestContext = {
  cookies: SessionCookieStore;
  headers: Headers;
};

const requestContext = new AsyncLocalStorage<SessionRequestContext>();

export async function runWithSessionRequestContext<T>(
  context: SessionRequestContext,
  callback: () => Promise<T>,
): Promise<T> {
  return requestContext.run(context, callback);
}

async function currentRequestContext(): Promise<SessionRequestContext> {
  const context = requestContext.getStore();
  if (context) return context;
  const nextHeaders = await import("next/headers");
  return { cookies: await nextHeaders.cookies(), headers: await nextHeaders.headers() };
}

function ttlSeconds(): number {
  const raw = process.env.SESSION_TTL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 60 && parsed <= 60 * 60 * 24 * 30) return parsed;
  return DEFAULT_TTL_SECONDS;
}

/**
 * The cookie is marked Secure when the request reached us over HTTPS.
 * On Vercel (and any TLS-terminating proxy) `x-forwarded-proto` is `https`.
 * Deriving it per request avoids locking out local http:// development while
 * still being strict in production.
 */
async function requestIsSecure(): Promise<boolean> {
  const headerList = (await currentRequestContext()).headers;
  const forwarded = headerList.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim().toLowerCase() === "https";
  return process.env.NODE_ENV === "production" && process.env.VERCEL === "1";
}

export async function createSession(userId: string): Promise<void> {
  const token = generateSessionToken();
  const ttl = ttlSeconds();
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await db.insert(sessions).values({
    id: newId(),
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const jar = (await currentRequestContext()).cookies;
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await requestIsSecure(),
    path: "/",
    maxAge: ttl,
  });
}

export async function destroyCurrentSession(): Promise<{ hadToken: boolean }> {
  const jar = (await currentRequestContext()).cookies;
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return { hadToken: false };
  try {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
  } catch (error) {
    console.error("session-revocation-failed", {
      code: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Session revocation failed.", { cause: error });
  }
  jar.delete(SESSION_COOKIE);
  return { hadToken: true };
}

/** Returns the signed-in user, or null. Never trusts client-supplied ids. */
export async function getCurrentUser(): Promise<User | null> {
  const jar = (await currentRequestContext()).cookies;
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    // Expired or revoked: return null. Cookie deletion is handled by the logout route handler.
    return null;
  }
  return rows[0].user;
}

/** Server-component guard: sends anonymous visitors to /login. */
export async function requireUserOrRedirect(): Promise<User> {
  const user = await getCurrentUser();
  if (user) return user;
  const { redirect } = await import("next/navigation");
  return redirect(`/login?next=${encodeURIComponent("/dashboard")}`);
}

/**
 * Cross-site request forgery defence for state-changing API routes.
 * SameSite=Lax already blocks most cross-site form posts; this adds an explicit
 * same-origin check on Origin/Referer/Sec-Fetch-Site.
 */
export async function isSameOriginMutation(request: Request): Promise<boolean> {
  return isSameOriginMutationRequest(request);
}

/**
 * Strict CSRF/origin check for cookie-authenticated mutations. Unlike the
 * permissive variant it refuses a request that supplies no Origin, Referer or
 * Sec-Fetch-Site at all, because such a request cannot be a browser form/fetch
 * and must therefore be a scripted client carrying our session cookie.
 */
export async function isTrustedMutation(request: Request): Promise<boolean> {
  return isTrustedMutationRequest(request);
}

export async function nextFromRequest(request: Request): Promise<string> {
  const url = new URL(request.url);
  return safeRedirectPath(url.searchParams.get("next"));
}

/** Counts active sessions for a user (used by the account panel). */
export async function countActiveSessions(userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())),
    );
  return rows[0]?.count ?? 0;
}
