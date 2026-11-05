import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { scanReports } from "@/db/schema";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { checkScanRateLimit, rateLimitMax, rateLimitWindowMinutes } from "@/lib/rate-limit";
import { ScanForm } from "@/components/scan-form";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { OUTCOME_CLASS, OUTCOME_LABEL, formatDate, formatDuration } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };

type Summary = Record<string, number>;

function issueCount(summary: Summary | null): number {
  if (!summary) return 0;
  return Number(summary.fail ?? 0);
}

function warnCount(summary: Summary | null): number {
  if (!summary) return 0;
  return Number(summary.warn ?? 0);
}

export default async function DashboardPage() {
  const user = await requireUserOrRedirect();

  const [scans, quota] = await Promise.all([
    db
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
      // Ownership is taken from the session, never from the request.
      .where(eq(scanReports.userId, user.id))
      .orderBy(desc(scanReports.startedAt))
      .limit(50),
    checkScanRateLimit(user.id),
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader user={{ email: user.email }} />

      <main id="main" className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-signal-400">Dashboard</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-mist-100">Run a configuration check</h1>
              <p className="mt-2 max-w-2xl text-sm text-mist-400">
                Signed in as <span className="text-mist-200">{user.email}</span>. Only your own scans are listed here.
              </p>
            </div>
            <p className="text-xs text-mist-500">
              Quota: {quota.remaining}/{quota.limit} remaining in the last {rateLimitWindowMinutes()} minutes (limit{" "}
              {rateLimitMax()}).
            </p>
          </div>

          <section
            aria-labelledby="new-scan-heading"
            className="mt-8 rounded-xl border border-ink-700 bg-ink-900 p-5 sm:p-6"
          >
            <h2 id="new-scan-heading" className="sr-only">
              New scan
            </h2>
            <ScanForm remaining={quota.remaining} limit={quota.limit} windowMinutes={quota.windowMinutes} />
          </section>

          <section aria-labelledby="history-heading" className="mt-12">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="history-heading" className="text-xl font-semibold tracking-tight text-mist-100">
                Your scan history
              </h2>
              <p className="text-xs text-mist-500">{scans.length} report(s), newest first</p>
            </div>

            {scans.length === 0 ? (
              <div className="mt-5 rounded-lg border border-dashed border-ink-600 bg-ink-900/50 p-10 text-center">
                <p className="text-base font-medium text-mist-200">No scans yet</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-mist-500">
                  Submit a public website URL above. The first report will appear here with its evidence, severity and
                  remediation guidance.
                </p>
              </div>
            ) : (
              <div className="mt-5 overflow-hidden rounded-lg border border-ink-700">
                {/* Table on wide screens */}
                <table className="hidden w-full border-collapse text-left text-sm md:table">
                  <caption className="sr-only">Previous scans belonging to {user.email}</caption>
                  <thead className="bg-ink-850 text-xs uppercase tracking-wide text-mist-500">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">Target</th>
                      <th scope="col" className="px-4 py-3 font-medium">Outcome</th>
                      <th scope="col" className="px-4 py-3 font-medium">Issues</th>
                      <th scope="col" className="px-4 py-3 font-medium">Warnings</th>
                      <th scope="col" className="px-4 py-3 font-medium">Duration</th>
                      <th scope="col" className="px-4 py-3 font-medium">When (UTC)</th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        <span className="sr-only">Open report</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-800 bg-ink-900">
                    {scans.map((scan) => (
                      <tr key={scan.id} className="transition-colors hover:bg-ink-850">
                        <td className="max-w-[22rem] px-4 py-3">
                          <span className="block truncate font-mono text-xs text-mist-200" title={scan.inputUrl}>
                            {scan.targetHost ?? scan.inputUrl}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${OUTCOME_CLASS[scan.status] ?? OUTCOME_CLASS.failed}`}>
                            {OUTCOME_LABEL[scan.status] ?? scan.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-mist-300">{issueCount(scan.summary as Summary | null)}</td>
                        <td className="px-4 py-3 text-mist-300">{warnCount(scan.summary as Summary | null)}</td>
                        <td className="px-4 py-3 text-mist-400">{formatDuration(scan.durationMs)}</td>
                        <td className="px-4 py-3 text-mist-400">{formatDate(scan.startedAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            href={`/dashboard/scans/${scan.id}`}
                            className="rounded-md border border-ink-600 px-3 py-1.5 text-xs font-medium text-signal-300 transition-colors hover:border-signal-400/50 hover:bg-signal-400/10"
                          >
                            View report
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Cards on small screens */}
                <ul className="divide-y divide-ink-800 bg-ink-900 md:hidden">
                  {scans.map((scan) => (
                    <li key={scan.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 break-all font-mono text-xs text-mist-200">{scan.targetHost ?? scan.inputUrl}</span>
                        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${OUTCOME_CLASS[scan.status] ?? OUTCOME_CLASS.failed}`}>
                          {OUTCOME_LABEL[scan.status] ?? scan.status}
                        </span>
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-mist-400">
                        <div className="flex justify-between gap-2">
                          <dt>Issues</dt>
                          <dd className="text-mist-200">{issueCount(scan.summary as Summary | null)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Warnings</dt>
                          <dd className="text-mist-200">{warnCount(scan.summary as Summary | null)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Duration</dt>
                          <dd className="text-mist-200">{formatDuration(scan.durationMs)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>When</dt>
                          <dd className="text-mist-200">{formatDate(scan.startedAt)}</dd>
                        </div>
                      </dl>
                      <Link
                        href={`/dashboard/scans/${scan.id}`}
                        className="mt-3 inline-block rounded-md border border-ink-600 px-3 py-1.5 text-xs font-medium text-signal-300"
                      >
                        View report
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-4 text-xs leading-relaxed text-mist-500">
              Counts reflect findings from the single unauthenticated request each scan performed. A report with zero
              issues does not mean the site is secure — read the limitations on every finding. See{" "}
              <Link href="/methodology" className="text-signal-300 underline">
                methodology
              </Link>
              .
            </p>
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
