import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { scanReports } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { jsonError, notFound, trustedOrigin, unauthorized } from "@/lib/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/scans/[id]
 * The ownership predicate is part of the query: a report belonging to another
 * user is indistinguishable from one that does not exist (both are 404).
 */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return notFound();

  const rows = await db
    .select()
    .from(scanReports)
    .where(and(eq(scanReports.id, id), eq(scanReports.userId, user.id)))
    .limit(1);

  const report = rows[0];
  if (!report) return notFound();

  return Response.json({ ok: true, report });
}

/** DELETE /api/scans/[id] — removes only the caller's own report. */
export async function DELETE(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  // Cookie-authenticated mutation: require positive same-origin evidence.
  if (!(await trustedOrigin(request))) {
    return jsonError(403, "cross-origin", "Cross-origin requests are not accepted.");
  }

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return notFound();

  const deleted = await db
    .delete(scanReports)
    .where(and(eq(scanReports.id, id), eq(scanReports.userId, user.id)))
    .returning({ id: scanReports.id });

  if (deleted.length === 0) return notFound();
  return Response.json({ ok: true, deleted: deleted[0].id });
}
