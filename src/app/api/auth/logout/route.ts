import { destroyCurrentSession } from "@/lib/auth/session";
import { jsonError, trustedOrigin } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/auth/logout — revokes the session row and clears the cookie. */
export async function POST(request: Request) {
  // Cookie-authenticated mutation: require positive same-origin evidence.
  if (!(await trustedOrigin(request))) {
    return jsonError(403, "cross-origin", "Cross-origin requests are not accepted.");
  }
  try {
    await destroyCurrentSession();
    return Response.json({ ok: true });
  } catch {
    return jsonError(503, "logout-failed", "The session could not be revoked. Please try again.");
  }
}
