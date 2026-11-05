import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, newId, normaliseEmail, validatePassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { clientAddressFromHeaders, consumeSignupAttempt } from "@/lib/auth/attempt-limit";
import { InvalidBodyError, jsonError, originAllowed, readJsonBody, stringField } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signup
 * Body: { email, password, next? }
 *
 * Server-side validation is authoritative: the UI validation is only feedback.
 */
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
  if (!emailCheck.ok) return jsonError(400, "invalid-email", emailCheck.reason);

  const password = stringField(body, "password", 256);
  const passwordCheck = validatePassword(password ?? "");
  if (!passwordCheck.ok) return jsonError(400, "weak-password", passwordCheck.reason);

  // Bound account creation per address and per address value before we spend
  // scrypt time or touch the database.
  const attempt = consumeSignupAttempt({
    email: emailCheck.email,
    clientAddress: clientAddressFromHeaders(request.headers),
  });
  if (!attempt.allowed) {
    return jsonError(
      429,
      "too-many-attempts",
      `Too many sign-up attempts. Try again in ${Math.ceil(attempt.retryAfterSeconds / 60)} minute(s).`,
      { "Retry-After": String(attempt.retryAfterSeconds) },
    );
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, emailCheck.email))
    .limit(1);

  if (existing.length > 0) {
    // Known trade-off: this reveals that the address is registered. It is the
    // standard UX choice for email/password products and is mitigated by the
    // login rate limiting documented in docs/SECURITY.md.
    return jsonError(409, "email-in-use", "That email address is already registered. Try signing in instead.");
  }

  const passwordHash = await hashPassword(password as string);
  const [created] = await db
    .insert(users)
    .values({ id: newId(), email: emailCheck.email, passwordHash })
    .returning({ id: users.id, email: users.email });

  await createSession(created.id);

  const next = typeof body.next === "string" ? body.next : "/dashboard";
  return Response.json({ ok: true, user: { id: created.id, email: created.email }, next }, { status: 201 });
}
