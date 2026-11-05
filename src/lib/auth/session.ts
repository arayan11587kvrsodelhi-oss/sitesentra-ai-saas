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
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";

import { db } from "@/db";
import { sessions, users, type User } from "@/db/schema";
import { generateSessionToken, hashToken, newId, safeRedirectPath } from "@/lib/auth/password";
import { isSameOriginMutationRequest, isTrustedMutationRequest } from "@/lib/auth/origin-policy";

export const SESSION_COOKIE = "ss_session";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

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
  const headerList = await headers();
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

  // Opportunistic hygiene: drop long-expired sessions so the table stays small.
  await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(Date.now() - 24 * 60 * 60 * 1000)))
    .catch(() => undefined);

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await requestIsSecure(),
    path: "/",
    maxAge: ttl,
  });
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    // Revoke server-side too, so the row cannot be replayed if the cookie was
    // copied before logout. A DB failure here means the session row stays
    // active until it expires naturally; we log rather than silently ignore.
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
      .catch((error) => {
        console.error("session-revocation-failed", {
          code: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }
  jar.delete(SESSION_COOKIE);
}

/** Returns the signed-in user, or null. Never trusts client-supplied ids. */
export async function getCurrentUser(): Promise<User | null> {
  const jar = await cookies();
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
  if (!user) {
    redirect(`/login?next=${encodeURIComponent("/dashboard")}`);
  }
  return user;
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
