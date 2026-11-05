import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { scanReports } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { jsonError, readJsonBody, stringField, trustedOrigin, unauthorized, InvalidBodyError } from "@/lib/http";
import { runScanForUser } from "@/lib/scanner/run-scan";

export const dynamic = "force-dynamic";
/** A scan is bounded by the scanner's own budget; keep the route generous but finite. */
export const maxDuration = 60;

/**
 * POST /api/scans — body: { url }
 * Runs a real configuration check and persists the report.
 * The scan is synchronous so the user sees an honest result or an honest failure.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  // Cookie-authenticated mutation: require positive same-origin evidence.
  if (!(await trustedOrigin(request))) {
    return jsonError(403, "cross-origin", "Cross-origin requests are not accepted.");
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof InvalidBodyError) return jsonError(400, "invalid-body", error.message);
    return jsonError(413, "body-too-large", "Request body is too large.");
  }

  const url = stringField(body, "url", 2048);
  if (!url) {
    return jsonError(400, "invalid-url", "Provide a URL of 2048 characters or fewer, for example https://example.com");
  }

  try {
    const result = await runScanForUser(user, url);
    if (!result.ok) {
      return jsonError(429, result.error.kind, result.error.message, {
        "Retry-After": String(result.error.retryAfterSeconds),
      });
    }
    return Response.json({ ok: true, reportId: result.reportId, outcome: result.outcome }, { status: 201 });
  } catch (error) {
    // Never leak internals. Log server-side, return a generic 500.
    console.error("scan-failed", { code: error instanceof Error ? error.name : "unknown" });
    return jsonError(500, "scan-failed", "The scan could not be completed. No security conclusion was drawn.");
  }
}

/** GET /api/scans — the signed-in user's own history, newest first. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const rows = await db
    .select({
      id: scanReports.id,
      inputUrl: scanReports.inputUrl,
      targetHost: scanReports.targetHost,
      status: scanReports.status,
      summary: scanReports.summary,
      failureCode: scanReports.failureCode,
      durationMs: scanReports.durationMs,
      startedAt: scanReports.startedAt,
    })
    .from(scanReports)
    // Ownership comes from the session, never from a query parameter.
    .where(eq(scanReports.userId, user.id))
    .orderBy(desc(scanReports.startedAt))
    .limit(50);

  return Response.json({ ok: true, scans: rows });
}
