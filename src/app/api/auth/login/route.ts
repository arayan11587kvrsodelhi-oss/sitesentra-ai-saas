import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, normaliseEmail, safeRedirectPath, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import {
  clientAddressFromHeaders,
  consumeLoginAttempt,
  resetLoginAttempts,
} from "@/lib/auth/attempt-limit";
import { InvalidBodyError, jsonError, originAllowed, readJsonBody, stringField } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Dummy hash used to keep response times similar whether or not the email
 * exists, so timing cannot be used to enumerate registered accounts.
 * Generated once per process; it is not a credential.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("sitesentra-timing-equaliser-not-a-real-password");
  return dummyHashPromise;
}

const GENERIC_FAILURE = "Email or password is incorrect.";

/** POST /api/auth/login — body: { email, password, next? } */
export async function POST(request: Request) {
  if (!(await originAllowed(request))) {
    return jsonError(403, "cross-origin", "Cross-origin form submissions are not accepted.");
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof InvalidBodyError) return jsonError(400, "invalid-body", error.message);
    return jsonError(413, "body-too-large", "Request body is too large.");
  }

  const emailCheck = normaliseEmail(body.email);
  const password = stringField(body, "password", 256);

  if (!emailCheck.ok || password === null) {
    return jsonError(400, "invalid-credentials", GENERIC_FAILURE);
  }

  // Throttle BEFORE any password verification so an attacker cannot use the
  // scrypt cost to burn CPU, and so guesses are bounded per account AND per
  // client address. A blocked attempt never touches the database.
  const attempt = consumeLoginAttempt({
    email: emailCheck.email,
    clientAddress: clientAddressFromHeaders(request.headers),
  });
  if (!attempt.allowed) {
    return jsonError(
      429,
      "too-many-attempts",
      `Too many sign-in attempts. Try again in ${Math.ceil(attempt.retryAfterSeconds / 60)} minute(s).`,
      { "Retry-After": String(attempt.retryAfterSeconds) },
    );
  }

  const rows = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, emailCheck.email))
    .limit(1);

  const user = rows[0];
  const hashToCheck = user?.passwordHash ?? (await dummyHash());
  const passwordOk = await verifyPassword(password, hashToCheck);

  if (!user || !passwordOk) {
    return jsonError(401, "invalid-credentials", GENERIC_FAILURE);
  }

  // Successful credentials clear the per-account bucket so earlier typos do not
  // keep a legitimate user locked out for the rest of the window.
  resetLoginAttempts(emailCheck.email);

  await createSession(user.id);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id)).catch(() => undefined);

  const next = safeRedirectPath(typeof body.next === "string" ? body.next : "/dashboard");
  return Response.json({ ok: true, user: { id: user.id, email: user.email }, next });
}
