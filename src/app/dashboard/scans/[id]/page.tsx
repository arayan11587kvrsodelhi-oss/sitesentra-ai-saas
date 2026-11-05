import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { scanReports } from "@/db/schema";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { parseStoredReport } from "@/lib/scanner/run-scan";
import type { Finding, FindingStatus } from "@/lib/scanner/analyze";
import { DeleteScanButton } from "@/components/scan-actions";
import { FindingCard } from "@/components/finding-card";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { OUTCOME_CLASS, OUTCOME_LABEL, formatDate, formatDuration } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Scan report" };

type Props = { params: Promise<{ id: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GROUPS: Array<{ key: FindingStatus; heading: string; blurb: string }> = [
  { key: "fail", heading: "Issues found", blurb: "Observed problems, backed by the evidence below." },
  { key: "warn", heading: "Needs attention", blurb: "Observed weaknesses that are not definite failures." },
  { key: "inconclusive", heading: "Inconclusive", blurb: "Not enough was observable to judge. Treat these as unverified — not as passing." },
  { key: "pass", heading: "Observed OK", blurb: "The control was actually present on the assessed response." },
  { key: "not_applicable", heading: "Not applicable", blurb: "The check did not apply to what we could observe." },
  { key: "info", heading: "Information", blurb: "Context about the assessment itself." },
];

export default async function ScanReportPage({ params }: Props) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();

  const rows = await db
    .select()
    .from(scanReports)
    // Ownership predicate lives in the query itself.
    .where(and(eq(scanReports.id, id), eq(scanReports.userId, user.id)))
    .limit(1);

  const scan = rows[0];
  // Same 404 whether the report is missing or belongs to somebody else.
  if (!scan) notFound();

  const report = parseStoredReport(scan.report);

  const grouped = GROUPS.map((group) => ({
    ...group,
    findings: report ? report.findings.filter((finding) => finding.status === group.key) : [],
  })).filter((group) => group.findings.length > 0);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader user={{ email: user.email }} />

      <main id="main" className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
          <nav aria-label="Breadcrumb" className="text-sm">
            <ol className="flex items-center gap-2 text-mist-500">
              <li>
                <Link href="/dashboard" className="hover:text-mist-200">
                  Dashboard
                </Link>
              </li>
              <li aria-hidden="true">/</li>
              <li className="text-mist-300">Report</li>
            </ol>
          </nav>

          <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="break-all font-mono text-xl font-semibold tracking-tight text-mist-100 sm:text-2xl">
                {scan.targetHost ?? scan.inputUrl}
              </h1>
              <p className="mt-2 text-sm text-mist-500">
                Submitted: <span className="font-mono text-mist-300">{scan.inputUrl}</span>
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${OUTCOME_CLASS[scan.status] ?? OUTCOME_CLASS.failed}`}
              >
                Scan {OUTCOME_LABEL[scan.status] ?? scan.status}
              </span>
              <DeleteScanButton reportId={scan.id} />
            </div>
          </div>

          {!report ? (
            <div className="mt-8 rounded-lg border border-warn-400/30 bg-warn-400/5 p-6 text-sm text-warn-400">
              This stored report could not be parsed. Nothing is shown rather than guessing at its contents. Re-run the
              scan to produce a fresh report.
            </div>
          ) : (
            <>
              <section aria-labelledby="summary-heading" className="mt-8 rounded-xl border border-ink-700 bg-ink-900 p-5 sm:p-6">
                <h2 id="summary-heading" className="text-lg font-semibold text-mist-100">
                  Assessment summary
                </h2>

                {report.outcome !== "completed" ? (
                  <p
                    className={`mt-3 rounded-md border px-4 py-3 text-sm leading-relaxed ${
                      report.outcome === "failed"
                        ? "border-bad-400/30 bg-bad-400/5 text-bad-400"
                        : "border-signal-400/30 bg-signal-400/5 text-signal-300"
                    }`}
                  >
                    <strong className="font-semibold">
                      {report.outcome === "failed" ? "This scan did not assess the target. " : "This scan was inconclusive. "}
                    </strong>
                    {report.failure.message ??
                      "The findings below describe what could and could not be observed — they are not a security assessment."}
                  </p>
                ) : null}

                <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    { label: "Issues", value: String(report.summary.fail), tone: "text-bad-400" },
                    { label: "Warnings", value: String(report.summary.warn), tone: "text-warn-400" },
                    { label: "Observed OK", value: String(report.summary.pass), tone: "text-ok-400" },
                    {
                      label: "Inconclusive / N/A",
                      value: String(report.summary.inconclusive + report.summary.not_applicable),
                      tone: "text-signal-300",
                    },
                  ].map((item) => (
                    <div key={item.label} className="rounded-lg border border-ink-700 bg-ink-950 p-4">
                      <dt className="text-xs uppercase tracking-wide text-mist-500">{item.label}</dt>
                      <dd className={`mt-1 text-2xl font-semibold ${item.tone}`}>{item.value}</dd>
                    </div>
                  ))}
                </dl>

                <dl className="mt-5 grid gap-x-6 gap-y-2.5 border-t border-ink-800 pt-5 text-sm sm:grid-cols-2">
                  {[
                    { label: "Assessed response", value: report.assessedUrl ?? "none — no response was assessed" },
                    { label: "Scanned at (UTC)", value: formatDate(report.meta.scannedAt) },
                    { label: "Duration", value: formatDuration(report.meta.durationMs) },
                    { label: "Requests sent", value: String(report.meta.transcript.length) },
                    {
                      label: "Validated addresses connected to",
                      value: report.meta.validatedAddresses.length > 0 ? report.meta.validatedAddresses.join(", ") : "none",
                    },
                    { label: "Scanner user agent", value: report.meta.userAgent },
                  ].map((item) => (
                    <div key={item.label} className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
                      <dt className="text-xs uppercase tracking-wide text-mist-500">{item.label}</dt>
                      <dd className="break-words font-mono text-xs text-mist-300">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section aria-labelledby="findings-heading" className="mt-10">
                <h2 id="findings-heading" className="text-xl font-semibold tracking-tight text-mist-100">
                  Findings
                </h2>
                <p className="mt-2 max-w-3xl text-sm text-mist-400">
                  Grouped by what was actually observed. {report.findings.length} checks were recorded for this scan.
                </p>

                <div className="mt-6 space-y-8">
                  {grouped.map((group) => (
                    <div key={group.key}>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="text-base font-semibold text-mist-100">{group.heading}</h3>
                        <span className="text-xs text-mist-500">
                          {group.findings.length} · {group.blurb}
                        </span>
                      </div>
                      <div className="mt-3 space-y-3">
                        {group.findings.map((finding: Finding) => (
                          <FindingCard
                            key={finding.id}
                            finding={finding}
                            defaultOpen={finding.status === "fail"}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section aria-labelledby="transcript-heading" className="mt-12">
                <h2 id="transcript-heading" className="text-xl font-semibold tracking-tight text-mist-100">
                  Raw observation transcript
                </h2>
                <p className="mt-2 max-w-3xl text-sm text-mist-400">
                  Every hop we observed, with the response headers exactly as received. Set-Cookie values are redacted
                  before storage — only cookie names and flags are kept, because cookie values can be session secrets.
                </p>

                <div className="mt-5 space-y-3">
                  {report.meta.transcript.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-ink-600 p-5 text-sm text-mist-500">
                      No requests were sent — the target was refused by the safety policy before any socket was opened.
                    </p>
                  ) : (
                    report.meta.transcript.map((hop, index) => (
                      <details key={`${hop.url}-${index}`} className="rounded-lg border border-ink-700 bg-ink-900">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm">
                          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="rounded border border-ink-600 bg-ink-850 px-2 py-0.5 text-[0.7rem] uppercase tracking-wide text-mist-400">
                              {hop.probe}
                            </span>
                            <span
                              className={`font-mono text-xs ${hop.statusCode === null ? "text-bad-400" : "text-mist-200"}`}
                            >
                              {hop.statusCode ?? hop.error?.code ?? "no response"}
                            </span>
                            <span className="min-w-0 flex-1 break-all font-mono text-xs text-mist-400">{hop.url}</span>
                            <span className="text-xs text-mist-500">{hop.responseTimeMs} ms</span>
                          </span>
                        </summary>
                        <div className="border-t border-ink-800 px-4 py-3">
                          {hop.tls ? (
                            <p className="mb-2 font-mono text-xs text-signal-300">
                              {hop.tls.protocol ?? "?"} · {hop.tls.cipher ?? "?"} · verified:{" "}
                              {hop.tls.authorized ? "yes" : `no (${hop.tls.authorizationError ?? "unknown"})`}
                            </p>
                          ) : null}
                          {hop.error ? (
                            <p className="mb-2 font-mono text-xs text-bad-400">
                              {hop.error.code}: {hop.error.message}
                            </p>
                          ) : null}
                          {Object.keys(hop.headers).length > 0 ? (
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-ink-800 bg-ink-950 p-3 font-mono text-[0.7rem] leading-relaxed text-mist-300">
                              {Object.entries(hop.headers)
                                .map(([name, values]) => `${name}: ${values.join(", ")}`)
                                .join("\n")}
                            </pre>
                          ) : (
                            <p className="font-mono text-xs text-mist-500">No response headers were received.</p>
                          )}
                          {hop.cookies.length > 0 ? (
                            <ul className="mt-3 space-y-1">
                              {hop.cookies.map((cookie) => (
                                <li key={cookie} className="font-mono text-xs text-mist-400">
                                  {cookie}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </details>
                    ))
                  )}
                </div>
              </section>
            </>
          )}

          <p className="mt-12 rounded-lg border border-ink-700 bg-ink-900/60 p-5 text-xs leading-relaxed text-mist-500">
            This report describes configuration observed during a single unauthenticated HTTP(S) request per origin. It
            is not a penetration test, it does not detect application vulnerabilities, and a clean result never proves a
            website is secure. Only submit sites you own or are authorised to test.
          </p>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
