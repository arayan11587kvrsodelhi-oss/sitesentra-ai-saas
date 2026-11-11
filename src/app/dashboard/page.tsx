import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { scanReports } from "@/db/schema";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { checkScanRateLimit } from "@/lib/rate-limit";
import { parseStoredReport } from "@/lib/scanner/run-scan";
import { ScanForm } from "@/components/scan-form";
import { HistoryTable } from "@/components/history-table";
import { PageHeader } from "@/components/page-header";
import { IconArrowRight, IconChevronRight, IconGauge, IconHistory, IconScan, IconShield } from "@/components/icons";
import { Badge, ButtonLink, DistributionBar, Panel, PanelHeader, SeverityDot, Stat } from "@/components/ui";
import { TrendChart, type TrendPoint } from "@/components/charts/trend-chart";
import { CompletionRing } from "@/components/charts/completion-ring";
import { CategoryBars, type CategoryRow } from "@/components/charts/category-bars";
import {
  CATEGORY_LABEL,
  OUTCOME_TONE,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  SEVERITY_TONE,
  countOf,
  formatRelative,
  severityCountsOf,
} from "@/components/severity";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Security overview" };

type SearchParams = Promise<{ url?: string }>;

/** A URL echoed back from the landing page is only pre-filled, never trusted. */
function prefillUrl(raw: string | undefined): string {
  if (!raw) return "";
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) return "";
  return /^https?:\/\//i.test(value) ? value : "";
}

function hostOf(scan: { targetHost: string | null; inputUrl: string }): string {
  const host = (scan.targetHost ?? scan.inputUrl).toLowerCase();
  return host.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
}

const CATEGORY_ORDER = ["headers", "transport", "tls", "cookies", "disclosure"];

/**
 * Everything on this page is computed from the signed-in user's own
 * `scan_reports` rows — the same query the history and report pages use.
 * No metric is hardcoded; when there is no data, the UI says so.
 */
export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUserOrRedirect();
  const params = await searchParams;

  const [scans, quota] = await Promise.all([
    db
      .select({
        id: scanReports.id,
        inputUrl: scanReports.inputUrl,
        targetHost: scanReports.targetHost,
        status: scanReports.status,
        summary: scanReports.summary,
        report: scanReports.report,
        failureCode: scanReports.failureCode,
        durationMs: scanReports.durationMs,
        startedAt: scanReports.startedAt,
      })
      .from(scanReports)
      .where(eq(scanReports.userId, user.id))
      .orderBy(desc(scanReports.startedAt))
      .limit(50),
    checkScanRateLimit(user.id),
  ]);

  const totalScans = scans.length;
  const completed = scans.filter((scan) => scan.status === "completed").length;
  const failed = scans.filter((scan) => scan.status === "failed").length;
  const inconclusive = scans.filter((scan) => scan.status === "inconclusive").length;

  // Only scans that reached the target contribute finding counts. A failed
  // scan's stored summary still records its own refusal, which is not a finding
  // about the target and must never be shown as an issue.
  const assessedScans = scans.filter((scan) => scan.status !== "failed");
  // "Assessed targets" means targets we actually observed. A host that was
  // refused by the safety policy was never assessed.
  const hosts = new Set(assessedScans.map(hostOf).filter(Boolean));
  const totalIssues = assessedScans.reduce((sum, scan) => sum + countOf(scan.summary, "fail"), 0);
  const totalWarnings = assessedScans.reduce((sum, scan) => sum + countOf(scan.summary, "warn"), 0);
  const totalPassed = assessedScans.reduce((sum, scan) => sum + countOf(scan.summary, "pass"), 0);

  // Severity is aggregated from each assessed report's own summary — a real
  // distribution, not an estimate. The stored `bySeverity` counts every
  // finding including passes, so the Info slice is whatever is left after the
  // graded (fail/warn) severities: that is the honest way to split it without
  // inventing per-severity detail the summary does not hold.
  const gradedCounts = SEVERITY_ORDER.filter((severity) => severity !== "info").map((severity) => ({
    key: severity,
    label: SEVERITY_LABEL[severity],
    tone: SEVERITY_TONE[severity],
    count: assessedScans.reduce((sum, scan) => sum + severityCountsOf(scan.summary)[severity], 0),
  }));
  const gradedTotal = gradedCounts.reduce((sum, item) => sum + item.count, 0);
  const severityTotals = [
    ...gradedCounts,
    {
      key: "info",
      label: SEVERITY_LABEL.info,
      tone: SEVERITY_TONE.info,
      count: Math.max(0, totalIssues + totalWarnings - gradedTotal),
    },
  ];
  const unreported = scans.filter((scan) => !scan.summary || Object.keys(scan.summary).length === 0).length;
  // Two distinct stored counters: checks that could not be judged, and checks
  // that did not apply. The persisted summary may use either key name.
  const totalInconclusive = scans.reduce(
    (sum, scan) =>
      sum +
      countOf(scan.summary, "inconclusive") +
      countOf(scan.summary, "not_applicable") +
      countOf(scan.summary, "na"),
    0,
  );

  // Every graded finding is actionable, by definition: fail or warn.
  const actionableFindings = totalIssues + totalWarnings;
  const recent = scans.slice(0, 6);

  // ---- Trend: one point per *assessed* scan, oldest → newest (reads L→R).
  // A failed scan never observed the target, so it has no finding counts to
  // plot — including it would draw a fake "0 findings" data point.
  const trendPoints: TrendPoint[] = [...scans]
    .reverse()
    .filter((scan) => scan.status === "completed")
    .map((scan) => ({
      at: scan.startedAt.toISOString(),
      actionable: countOf(scan.summary, "fail") + countOf(scan.summary, "warn"),
      passed: countOf(scan.summary, "pass"),
      label: hostOf(scan) || "target",
      status: scan.status,
    }));

  // ---- Findings by area: parsed from the stored report of each *assessed*
  // scan. A failed scan still records its own refusal (severity "info"), which
  // is not a finding about the target and must not appear as one here.
  const categoryTally = new Map<string, { actionable: number; passed: number }>();
  for (const scan of assessedScans) {
    const report = parseStoredReport(scan.report);
    if (!report) continue;
    for (const finding of report.findings) {
      const entry = categoryTally.get(finding.category) ?? { actionable: 0, passed: 0 };
      if (finding.status === "fail" || finding.status === "warn") entry.actionable += 1;
      if (finding.status === "pass") entry.passed += 1;
      categoryTally.set(finding.category, entry);
    }
  }
  const categoryRows: CategoryRow[] = CATEGORY_ORDER.filter((key) => categoryTally.has(key)).map((key) => ({
    key,
    label: CATEGORY_LABEL[key] ?? key,
    actionable: categoryTally.get(key)?.actionable ?? 0,
    passed: categoryTally.get(key)?.passed ?? 0,
  }));

  // ---- Recent targets: distinct hosts with their last stored URL and count.
  // Failed scans are excluded: most were refused by the safety policy, so
  // offering them as "assessed before" would invite a guaranteed failure.
  const targetMap = new Map<string, { host: string; url: string; count: number; lastAt: string }>();
  for (const scan of scans) {
    if (scan.status === "failed") continue;
    const host = hostOf(scan);
    if (!host) continue;
    const existing = targetMap.get(host);
    if (existing) existing.count += 1;
    else
      targetMap.set(host, {
        host,
        url: /^https?:\/\//i.test(scan.inputUrl) ? scan.inputUrl : `https://${host}`,
        count: 1,
        lastAt: formatRelative(scan.startedAt),
      });
  }
  const recentTargets = [...targetMap.values()].slice(0, 5);

  const latestScan = scans[0];
  const latestTargetable = latestScan ? countOf(latestScan.summary, "fail") + countOf(latestScan.summary, "warn") : 0;
  const latestOutcome = latestScan
    ? latestScan.status === "completed" || latestScan.status === "inconclusive"
      ? latestScan.status
      : "failed"
    : null;

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <span className="kicker whitespace-nowrap">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
              Overview
            </span>
            <span className="mono text-[11px] text-faint">
              {totalScans === 1 ? "1 report" : `${totalScans} reports`} · last 50 stored
            </span>
          </>
        }
        title={<>Security overview</>}
        description="Run a configuration check and review what your assessed targets actually serve — every figure below is counted from your own stored reports."
        meta={
          <>
            <span className="flex items-center gap-1.5 rounded-full border border-line-teal bg-teal/30 px-2.5 py-1 text-[10.5px] text-mint">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
              {quota.remaining}/{quota.limit} scans left · {quota.windowMinutes}-min window
            </span>
            <span className="mono text-[11.5px] text-faint" title={user.email}>
              {user.email}
            </span>
          </>
        }
        actions={
          <ButtonLink href="/dashboard/history" variant="secondary" size="md" className="gap-1.5">
            <IconHistory size={15} />
            History
          </ButtonLink>
        }
      />

      <div className="space-y-4 px-[var(--gutter)] py-5 sm:space-y-5 sm:py-6">
        {/* ── Scan workspace ─────────────────────────────────────────── */}
        <div className="grid gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Panel as="section" className="relative overflow-hidden" >
            <div id="run-check" className="scroll-mt-28" />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-24 right-0 size-64 max-w-full rounded-full bg-mint/[0.06] blur-3xl"
            />
            <div className="relative p-5 sm:p-6">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl border border-line-teal bg-teal text-mint">
                    <IconScan size={18} />
                  </span>
                  <div>
                    <h2 className="h2">Run a new check</h2>
                    <p className="mt-0.5 text-[12px] text-muted">
                      One unauthenticated request per origin, on the default ports.
                    </p>
                  </div>
                </div>
                {latestScan && latestOutcome ? (
                  <Link
                    href={`/dashboard/scans/${latestScan.id}`}
                    className="group flex items-center gap-2 rounded-full border border-line bg-panel py-1 pr-2.5 pl-1.5 text-[11px] text-muted transition-colors hover:border-line-teal hover:text-fg"
                  >
                    <span className="mono px-1 text-[10px] tracking-[0.08em] text-faint uppercase">Last</span>
                    <span className="mono max-w-[9rem] truncate text-soft">{hostOf(latestScan)}</span>
                    <Badge tone={latestOutcome === "failed" ? "neutral" : OUTCOME_TONE[latestOutcome]} dot>
                      {latestOutcome === "failed" ? "not assessed" : `${latestTargetable} actionable`}
                    </Badge>
                    <IconChevronRight size={12} className="text-faint transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : null}
              </div>
              <ScanForm
                remaining={quota.remaining}
                limit={quota.limit}
                windowMinutes={quota.windowMinutes}
                defaultUrl={prefillUrl(params.url)}
                recentTargets={recentTargets}
              />
            </div>
          </Panel>

          {/* Assessment pipeline — what the scan actually does */}
          <Panel as="aside" className="flex flex-col">
            <PanelHeader title="In this scan" meta="5 stages" eyebrow="Pipeline" />
            <ol className="flex-1 space-y-0 px-5 py-2">
              {[
                ["Input validation", "SSRF & abuse policy before any socket"],
                ["Name resolution", "DNS pinned to the validated address"],
                ["Probe", "HTTPS + HTTP with hop re-validation"],
                ["Observation", "TLS handshake, headers, cookie flags"],
                ["Report", "Findings, transcript and evidence persisted"],
              ].map(([title, body], index) => (
                <li key={title} className="relative flex gap-3 py-2.5">
                  <span className="relative flex w-4 shrink-0 justify-center">
                    {index < 4 ? (
                      <span aria-hidden="true" className="absolute top-5 bottom-[-0.75rem] w-px bg-line" />
                    ) : null}
                    <span className="relative z-10 mt-1 flex size-3 items-center justify-center rounded-full border border-line-teal bg-teal">
                      <span className="size-1 rounded-full bg-mint" />
                    </span>
                  </span>
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium text-fg">{title}</p>
                    <p className="mt-0.5 text-[11px] leading-4 text-faint">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="border-t border-line px-5 py-3">
              <Link href="/methodology" className="inline-flex items-center gap-1 text-[12px] text-soft hover:text-mint">
                Methodology &amp; limits <IconChevronRight size={12} />
              </Link>
            </div>
          </Panel>
        </div>

        {/* ── Metric tiles ───────────────────────────────────────────── */}
        <section aria-labelledby="metrics-heading">
          <h2 id="metrics-heading" className="sr-only">
            Summary metrics
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-4">
            <Panel>
              <Stat
                label="Assessed targets"
                value={domainsValue(hosts.size)}
                detail={
                  assessedScans.length === 0
                    ? totalScans === 0
                      ? "Nothing assessed yet"
                      : "No scan reached its target"
                    : `${totalScans} ${totalScans === 1 ? "report" : "reports"} · ${completed} completed`
                }
                icon={<IconScan size={14} />}
                meter={totalScans > 0 ? completed / totalScans : undefined}
              />
            </Panel>
            <Panel>
              <Stat
                label="Actionable findings"
                value={actionableFindings}
                tone="critical"
                detail={
                  assessedScans.length === 0
                    ? "No assessed report yet"
                    : `${totalIssues} issues · ${totalWarnings} warnings across ${assessedScans.length} ${assessedScans.length === 1 ? "report" : "reports"}`
                }
                icon={<IconGauge size={14} />}
              />
            </Panel>
            <Panel>
              <Stat
                label="Controls observed OK"
                value={totalPassed}
                tone="pass"
                detail="Seen on a real response"
                icon={<IconShield size={14} />}
              />
            </Panel>
            <Panel>
              <Stat
                label="Unverified / N/A"
                value={totalInconclusive}
                tone="info"
                detail={
                  totalScans === 0
                    ? "Nothing assessed yet"
                    : `${inconclusive} inconclusive ${inconclusive === 1 ? "scan" : "scans"} · ${failed} failed${unreported > 0 ? ` · ${unreported} no counts` : ""}`
                }
                icon={<IconGauge size={14} />}
              />
            </Panel>
          </div>
        </section>

        {/* ── Charts ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Panel className="min-w-0 overflow-hidden">
            <PanelHeader
              title="Findings over time"
              eyebrow="Trend"
              meta={trendPoints.length > 0 ? `${trendPoints.length} completed` : undefined}
              action={
                trendPoints.length > 0 ? (
                  <Badge tone="brand" dot>
                    From stored reports
                  </Badge>
                ) : null
              }
            />
            <div className="px-5 pt-4 pb-5">
              {trendPoints.length >= 2 ? (
                <TrendChart points={trendPoints} />
              ) : trendPoints.length === 1 ? (
                <div className="flex flex-col items-start gap-3 py-6">
                  <p className="text-[13px] leading-6 text-muted">
                    One completed assessment stored. The trend appears once a second one exists — this view is drawn
                    only from scans that actually observed the target.
                  </p>
                  <div className="flex w-full items-center justify-between rounded-xl border border-line bg-panel px-4 py-3">
                    <span className="mono truncate text-[12px] text-soft">{trendPoints[0].label}</span>
                    <span className="mono text-[12px] text-mint">{trendPoints[0].actionable} actionable</span>
                  </div>
                </div>
              ) : (
                <FirstRun />
              )}
            </div>
          </Panel>

          <Panel className="min-w-0 overflow-hidden">
            <PanelHeader
              title="Severity distribution"
              eyebrow="Findings"
              meta={assessedScans.length > 0 ? `${assessedScans.length} assessed` : undefined}
            />
            <div className="px-5 py-5">
              {assessedScans.length === 0 ? (
                <EmptyMetrics />
              ) : (
                <>
                  <DistributionBar items={severityTotals} height={12} label="Actionable findings by severity" />
                  <p className="mt-3 text-[11px] leading-5 text-faint">
                    Graded severities only. Checks that passed or were informational are counted separately below.
                  </p>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4">
                    {[
                      { label: "Issues", value: totalIssues, className: "text-critical" },
                      { label: "Warnings", value: totalWarnings, className: "text-medium" },
                      { label: "Observed OK", value: totalPassed, className: "text-pass" },
                      { label: "Unverified / N/A", value: totalInconclusive, className: "text-info" },
                    ].map((cell) => (
                      <div key={cell.label} className="flex items-baseline justify-between gap-2">
                        <dt className="text-[11.5px] text-faint">{cell.label}</dt>
                        <dd className={`figure text-[15px] ${cell.className}`}>{cell.value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </div>
          </Panel>
        </div>

        {/* ── Breakdown + run state ──────────────────────────────────── */}
        <div className="grid gap-4 sm:gap-5 md:grid-cols-2 xl:grid-cols-3">
          <Panel className="xl:col-span-1">
            <PanelHeader title="Scan completion" eyebrow="Run state" />
            <div className="flex flex-col items-center gap-5 px-5 py-6">
              <CompletionRing completed={completed} total={totalScans} />
              <dl className="grid w-full grid-cols-3 gap-2 border-t border-line pt-4 text-center">
                {[
                  { label: "Done", value: completed, tone: "text-pass" },
                  { label: "Mixed", value: inconclusive, tone: "text-medium" },
                  { label: "Failed", value: failed, tone: "text-critical" },
                ].map((row) => (
                  <div key={row.label}>
                    <dd className={`figure text-[17px] ${row.tone}`}>{row.value}</dd>
                    <dt className="mono mt-1 text-[9.5px] tracking-[0.1em] text-faint uppercase">{row.label}</dt>
                  </div>
                ))}
              </dl>
            </div>
          </Panel>

          <Panel className="xl:col-span-1">
            <PanelHeader title="Findings by area" eyebrow="Category" />
            <div className="px-5 py-5">
              {categoryRows.length > 0 ? (
                <CategoryBars rows={categoryRows} />
              ) : (
                <p className="text-[12.5px] leading-6 text-muted">
                  Areas appear here once a report with a readable finding list is stored.
                </p>
              )}
              {categoryRows.length > 0 ? (
                <p className="mono mt-4 border-t border-line pt-3 text-[10px] tracking-[0.04em] text-faint">
                  <span className="text-medium">actionable</span> / <span className="text-pass">observed OK</span>
                </p>
              ) : null}
            </div>
          </Panel>

          <Panel as="aside" className="teal-surface relative overflow-hidden md:col-span-2 xl:col-span-1">
            <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0 opacity-30" />
            <div className="relative flex h-full flex-col justify-between gap-5 p-5">
              <div>
                <span className="mono inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/25 px-2.5 py-1 text-[10px] tracking-[0.12em] text-white/70 uppercase">
                  <span className="size-1.5 rounded-full bg-mint" />
                  Scope
                </span>
                <p className="mt-4 text-[15px] leading-6 font-medium text-white">
                  A clean report never means the site is secure.
                </p>
                <p className="mt-2 text-[12px] leading-5 text-white/65">
                  Each report describes configuration observed during a single unauthenticated request per origin. Every
                  finding carries its own limitations, and unverified checks are never counted as passes.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link href="/methodology" className="btn btn-sm bg-white/10 text-white hover:bg-white/15">
                  Methodology
                </Link>
                <Link href="/dashboard/history" className="btn btn-sm bg-mint text-[#02241f] hover:bg-[#22ddc9]">
                  All reports
                </Link>
              </div>
            </div>
          </Panel>
        </div>

        {/* ── Recent activity ────────────────────────────────────────── */}
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Recent scan activity"
            eyebrow="Activity"
            meta={totalScans > 0 ? `newest ${recent.length} of ${totalScans}` : "none yet"}
            action={
              totalScans > 0 ? (
                <Link href="/dashboard/history" className="btn btn-ghost btn-sm gap-1">
                  View all
                  <IconArrowRight size={13} />
                </Link>
              ) : null
            }
          />
          <HistoryTable scans={recent} variant="compact" />
        </Panel>
      </div>
    </>
  );
}

function domainsValue(hosts: number) {
  return hosts === 0 ? "—" : hosts;
}

function FirstRun() {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <div aria-hidden="true" className="flex h-16 w-full items-end justify-center gap-1.5 opacity-40">
        {[18, 26, 14, 34, 22, 40, 28, 46, 32, 52].map((height, index) => (
          <span key={index} className="w-3 rounded-t-sm bg-gradient-to-t from-teal/20 to-teal" style={{ height }} />
        ))}
      </div>
      <p className="text-[13px] font-medium text-soft">No completed assessments yet</p>
      <p className="max-w-xs text-[12px] leading-5 text-faint">
        The trend is drawn from scans that observed the target. A scan that failed was never assessed, so it cannot
        contribute a finding count.
      </p>
      <Link href="#run-check" className="btn btn-secondary btn-sm gap-1.5">
        Run a check <IconArrowRight size={13} />
      </Link>
    </div>
  );
}

function EmptyMetrics() {
  return (
    <div className="space-y-4">
      <div className="h-3 w-full rounded-full bg-inset" />
      <ul className="grid grid-cols-2 gap-2">
        {SEVERITY_ORDER.map((severity) => (
          <li key={severity} className="flex items-center justify-between gap-2 text-[11.5px] text-faint">
            <span className="flex items-center gap-2">
              <SeverityDot tone={SEVERITY_TONE[severity]} />
              {SEVERITY_LABEL[severity]}
            </span>
            <span className="mono">0</span>
          </li>
        ))}
      </ul>
      <p className="border-t border-line pt-4 text-[12px] leading-5 text-muted">
        Severity totals appear here once at least one report exists.
      </p>
    </div>
  );
}
