import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { scanReports } from "@/db/schema";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { parseStoredReport } from "@/lib/scanner/run-scan";
import type { Finding, FindingStatus, ScanOutcome, Severity } from "@/lib/scanner/analyze";
import { DeleteScanButton } from "@/components/scan-actions";
import { FindingCard } from "@/components/finding-card";
import { Transcript } from "@/components/report/transcript";
import { PageHeader } from "@/components/page-header";
import { Badge, DistributionBar, InlineAlert, Panel, PanelHeader } from "@/components/ui";
import { IconChevronRight, IconCheck, IconClock, IconMinus, IconShield } from "@/components/icons";
import {
  CATEGORY_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  SEVERITY_RANK,
  SEVERITY_TONE,
  STATUS_TONE,
  formatDate,
  formatDuration,
} from "@/components/severity";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Scan report" };

type Props = { params: Promise<{ id: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Order matters: what needs action first, then what could not be judged, then
 * passing controls, then context. The raw order of the scanner's findings is
 * preserved *inside* each group (stable sort).
 */
const GROUPS: Array<{ key: FindingStatus; heading: string; blurb: string; defaultOpen: boolean; id: string }> = [
  {
    key: "fail",
    heading: "Issues found",
    blurb: "Concrete problems observed on the assessed response. Evidence is attached to each one.",
    defaultOpen: true,
    id: "issues",
  },
  {
    key: "warn",
    heading: "Needs attention",
    blurb: "Observed weaknesses that are not definite failures, but reduce the strength of a control.",
    defaultOpen: true,
    id: "warnings",
  },
  {
    key: "inconclusive",
    heading: "Inconclusive",
    blurb: "Not enough was observable to judge. Treat these as unverified — never as passing.",
    defaultOpen: false,
    id: "inconclusive",
  },
];

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-critical",
  high: "text-high",
  medium: "text-medium",
  low: "text-low",
  info: "text-info",
};

export default async function ScanReportPage({ params }: Props) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();

  const rows = await db
    .select()
    .from(scanReports)
    .where(and(eq(scanReports.id, id), eq(scanReports.userId, user.id)))
    .limit(1);

  const scan = rows[0];
  if (!scan) notFound();

  const report = parseStoredReport(scan.report);

  const byStatus = (status: FindingStatus): Finding[] =>
    report ? report.findings.filter((finding) => finding.status === status) : [];

  const analysed = report ? report.outcome === "completed" : false;

  /** "Issues found" / "Needs attention" only make sense if a target was assessed. */
  const groups = GROUPS.map((group) => ({ ...group, findings: byStatus(group.key) }))
    .filter((group) => group.findings.length > 0)
    .filter((group) => analysed || group.key === "inconclusive");

  const passed = byStatus("pass");
  const notApplicable = byStatus("not_applicable");
  const info = byStatus("info");
  // Policy/blocking findings are informational; on a failed scan they are the
  // whole record, so they are presented as context — never under "Issues".
  const contextFindings = analysed ? [...info, ...notApplicable] : [...byStatus("fail"), ...byStatus("warn"), ...info, ...notApplicable];

  const severityCounts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  if (report) {
    for (const finding of report.findings) {
      if (finding.status === "fail" || finding.status === "warn") severityCounts[finding.severity] += 1;
    }
  }

  const severityItems = SEVERITY_ORDER.map((severity) => ({
    key: severity,
    label: SEVERITY_LABEL[severity],
    tone: SEVERITY_TONE[severity],
    count: severityCounts[severity],
  }));

  const actionable = report ? report.summary.fail + report.summary.warn : 0;
  const outcome: ScanOutcome =
    report?.outcome ?? (scan.status === "completed" || scan.status === "inconclusive" ? scan.status : "failed");

  // Finding index: ordered by severity, then by the scanner's own order.
  const findingIndex = report ? [...report.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) : [];

  const target = scan.targetHost ?? scan.inputUrl;

  const checksRecorded = report ? report.findings.length : 0;
  // A scan that could not reach the target was not assessed — pass/warn/fail
  // counts mean nothing on their own, so the headline changes shape entirely.
  const assessed = report ? report.outcome === "completed" : false;
  const observedRatio =
    checksRecorded > 0 && assessed && report
      ? (report.summary.pass + report.summary.fail + report.summary.warn) / checksRecorded
      : 0;

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <span className="kicker">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
              Scan report
            </span>
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[11.5px] text-faint">
              <Link href="/dashboard" className="hover:text-soft">
                Overview
              </Link>
              <IconChevronRight size={11} />
              <Link href="/dashboard/history" className="hover:text-soft">
                History
              </Link>
              <IconChevronRight size={11} />
              <span className="mono text-muted">{scan.id.slice(0, 8)}</span>
            </nav>
          </>
        }
        title={<span className="mono break-all text-[1.4rem] sm:text-[1.75rem]">{target}</span>}
        description={<span className="mono text-[11.5px] break-all text-faint">{scan.inputUrl}</span>}
        meta={
          <>
            <Badge tone={OUTCOME_TONE[outcome]} dot>
              {OUTCOME_LABEL[outcome]}
            </Badge>
            <span className="flex items-center gap-1.5 mono text-[11.5px] text-muted">
              <IconClock size={12} className="text-faint" />
              {formatDate(scan.startedAt)}
            </span>
            <span className="mono text-[11.5px] text-faint">{formatDuration(scan.durationMs)}</span>
            <span aria-hidden="true" className="hidden h-3 w-px bg-line-strong sm:block" />
            <span className="mono hidden text-[11.5px] text-faint sm:inline">id {scan.id.slice(0, 8)}</span>
          </>
        }
        actions={
          <>
            <Link href="/dashboard/history" className="btn btn-secondary btn-sm">
              All reports
            </Link>
            <DeleteScanButton reportId={scan.id} />
          </>
        }
      />

      <div className="space-y-4 px-[var(--gutter)] py-5 sm:space-y-5 sm:py-6">
        {!report ? (
          <Panel className="p-5">
            <InlineAlert tone="warning" title="Report could not be parsed">
              This stored report could not be parsed. Nothing is shown rather than guessing at its contents. Re-run the
              scan to produce a fresh report.
            </InlineAlert>
          </Panel>
        ) : (
          <>
            {report.outcome === "inconclusive" ? (
              <InlineAlert tone="warning">
                <strong className="font-medium text-fg">This scan was inconclusive. </strong>
                The findings below describe what could not be observed — they are not a security assessment.
              </InlineAlert>
            ) : null}

            {/* ── Assessment summary ─────────────────────────────────── */}
            <Panel as="section" aria-labelledby="assessment-heading" className="overflow-hidden">
              <h2 id="assessment-heading" className="sr-only">
                Assessment summary
              </h2>
              <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
                <div className="border-b border-line p-5 sm:p-6 lg:border-r lg:border-b-0">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="eyebrow text-faint">{assessed ? "Actionable findings" : "Assessment"}</p>
                      {assessed ? (
                        <div className="mt-2 flex items-end gap-3">
                          <p className={`figure text-[3.25rem] leading-[0.9] ${actionable > 0 ? "text-fg" : "text-pass"}`}>
                            {actionable}
                          </p>
                          <p className="pb-1.5 text-[12px] leading-5 text-muted">
                            {report.summary.fail} issues · {report.summary.warn} warnings
                            <br />
                            {checksRecorded} checks recorded
                          </p>
                        </div>
                      ) : (
                        <div className="mt-2">
                          <p className="max-w-md text-[15px] leading-6 font-medium text-fg">
                            No security conclusion was drawn from this scan.
                          </p>
                          <p className="mt-1.5 max-w-md text-[12px] leading-5 text-muted">
                            {report.outcome === "failed"
                              ? "The target could not be observed, so no control was checked. The record below explains why."
                              : "A connection was made, but too little was observable to grade any control. Nothing here is a pass."}
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="eyebrow text-faint">Verdict</p>
                      <div className="mt-2">
                        <Badge tone={OUTCOME_TONE[report.outcome]} dot>
                          {OUTCOME_LABEL[report.outcome]}
                        </Badge>
                      </div>
                      {report.summary.highestActionableSeverity && report.summary.highestActionableSeverity !== "info" ? (
                        <p className="mono mt-2 text-[10.5px] text-faint">
                          highest{" "}
                          <span className={SEVERITY_TEXT[report.summary.highestActionableSeverity]}>
                            {SEVERITY_LABEL[report.summary.highestActionableSeverity]}
                          </span>
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {assessed ? (
                    <>
                      <div className="mt-6">
                        <p className="eyebrow text-faint">Severity of actionable findings</p>
                        <div className="mt-3">
                          <DistributionBar items={severityItems} height={12} label="Actionable findings by severity" />
                        </div>
                      </div>

                      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {[
                          { label: "Issues", value: report.summary.fail, tone: "text-critical", Icon: IconMinus },
                          { label: "Warnings", value: report.summary.warn, tone: "text-medium", Icon: IconMinus },
                          { label: "Observed OK", value: report.summary.pass, tone: "text-pass", Icon: IconCheck },
                          {
                            label: "Unverified",
                            value: report.summary.inconclusive + report.summary.not_applicable,
                            tone: "text-info",
                            Icon: IconMinus,
                          },
                        ].map((cell) => (
                          <div key={cell.label} className="rounded-xl border border-line bg-panel px-3 py-2.5">
                            <div className="flex items-center justify-between">
                              <p className="text-[10.5px] text-faint">{cell.label}</p>
                              <cell.Icon size={12} className={cell.tone} />
                            </div>
                            <p className={`figure mt-1 text-[18px] ${cell.tone}`}>{cell.value}</p>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}

                  {!assessed && report.outcome === "failed" && report.failure.message ? (
                    <p className="mono mt-4 rounded-xl border border-critical/25 bg-critical/[0.06] px-3 py-2 text-[11.5px] leading-5 text-critical">
                      {report.failure.message}
                    </p>
                  ) : null}

                  <div className={`flex items-center gap-3 ${assessed ? "mt-4" : "mt-6"}`}>
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-inset" aria-hidden="true">
                      <span className="block h-full rounded-full bg-gradient-to-r from-teal to-mint" style={{ width: `${observedRatio * 100}%` }} />
                    </div>
                    <span className="mono text-[10.5px] text-faint">
                      {assessed
                        ? `${Math.round(observedRatio * 100)}% of checks reached a conclusion`
                        : "No checks reached a conclusion"}
                    </span>
                  </div>
                </div>

                {/* Scan metadata */}
                <div className="p-5 sm:p-6">
                  <div className="flex items-center justify-between">
                    <p className="eyebrow text-faint">Scan record</p>
                    <span className="mono text-[10px] text-faint">{report.meta.transcript.length} requests</span>
                  </div>
                  <dl className="mt-3 divide-y divide-line/70">
                    {[
                      { label: "Assessed response", value: report.assessedUrl ?? "none — no response was assessed" },
                      { label: "Scanned at (UTC)", value: formatDate(report.meta.scannedAt) },
                      { label: "Duration", value: formatDuration(report.meta.durationMs) },
                      { label: "Requests sent", value: String(report.meta.transcript.length) },
                      {
                        label: "Validated addresses",
                        value: report.meta.validatedAddresses.length > 0 ? report.meta.validatedAddresses.join(", ") : "none",
                      },
                      { label: "Scanner user agent", value: report.meta.userAgent },
                      { label: "Report id", value: scan.id },
                    ].map((row) => (
                      <div key={row.label} className="py-2 first:pt-0 last:pb-0">
                        <dt className="text-[9.5px] leading-4 tracking-[0.1em] text-faint uppercase">{row.label}</dt>
                        <dd className="mono mt-0.5 text-[11px] leading-5 break-words text-soft">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            </Panel>

            {/* ── Category strip ─────────────────────────────────────── */}
            {report && assessed ? <CategoryStrip findings={report.findings} /> : null}

            {/* ── Findings ───────────────────────────────────────────── */}
            {report.findings.length > 0 ? (
              <div className="grid gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="min-w-0 space-y-4 sm:space-y-5">
                  {groups.map((group) => (
                    <Panel as="section" key={group.key} id={group.id} className="scroll-mt-24 overflow-hidden">
                      <PanelHeader
                        title={
                          <span className="flex items-center gap-2.5">
                            {group.heading}
                            <span className="mono rounded-full border border-line bg-inset px-2 py-0.5 text-[10.5px] font-normal text-muted">
                              {group.findings.length}
                            </span>
                          </span>
                        }
                        meta={group.blurb}
                      />
                      <div>
                        {group.findings.map((finding) => (
                          <FindingCard
                            key={finding.id}
                            finding={finding}
                            defaultOpen={group.defaultOpen && (finding.status === "fail" || finding.status === "warn")}
                          />
                        ))}
                      </div>
                    </Panel>
                  ))}

                  {/* Passed checks — compact, clearly a different thing */}
                  {passed.length > 0 ? (
                    <Panel as="section" id="passed" className="scroll-mt-24 overflow-hidden">
                      <PanelHeader
                        title={
                          <span className="flex items-center gap-2">
                            <IconCheck size={15} className="text-pass" />
                            Controls observed OK
                            <span className="mono rounded-full border border-line bg-inset px-2 py-0.5 text-[10.5px] font-normal text-muted">
                              {passed.length}
                            </span>
                          </span>
                        }
                        meta="Present on the assessed response — not a verdict on the whole site"
                      />
                      <ul className="grid sm:grid-cols-2">
                        {passed.map((finding) => {
                          const observed = finding.evidence.find((item) =>
                            ["Header value", "Negotiated protocol", "First response", "Result", "Protocol", "Final URL"].includes(
                              item.label,
                            ),
                          );
                          return (
                            <li key={finding.id} className="border-b border-line px-4 py-3 last:border-b-0 sm:px-5 sm:[&:nth-last-child(-n+2)]:border-b-0 sm:odd:border-r">
                              <div className="flex items-start gap-2.5">
                                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-pass/30 bg-pass/10">
                                  <IconCheck size={11} className="text-pass" />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <p className="text-[12.5px] font-medium text-fg">{finding.title}</p>
                                  <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-5 text-muted">{finding.whatWasChecked}</p>
                                  {observed ? (
                                    <p className="mono mt-1.5 truncate text-[10.5px] text-soft" title={observed.value}>
                                      <span className="text-faint">{observed.label}: </span>
                                      {observed.value}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </Panel>
                  ) : null}

                  {/* Raw transcript */}
                  <Panel as="section" id="transcript" className="scroll-mt-24 overflow-hidden">
                    <PanelHeader
                      title="Request transcript"
                      meta={`${report.meta.transcript.length} ${report.meta.transcript.length === 1 ? "request" : "requests"
                        } · cookie values redacted`}
                    />
                    <div className="border-b border-line px-5 py-2.5">
                      <p className="text-[11.5px] leading-5 text-muted">
                        Every hop we observed, with the response headers exactly as received. Cookie values are removed
                        before the report is stored — only names and flags are kept.
                      </p>
                    </div>
                    <Transcript hops={report.meta.transcript} />
                  </Panel>

                  {/* Secondary findings */}
                  {contextFindings.length > 0 ? (
                    <Panel as="section" id="context" className="scroll-mt-24 overflow-hidden">
                      <PanelHeader
                        title="Context"
                        meta={
                          analysed
                            ? `${info.length} information · ${notApplicable.length} not applicable`
                            : "what this scan could record"
                        }
                      />
                      <div>
                        {contextFindings.map((finding) => (
                          <FindingCard key={finding.id} finding={finding} />
                        ))}
                      </div>
                    </Panel>
                  ) : null}
                </div>

                {/* Sticky index */}
                <aside className="hidden xl:block">
                  <div className="sticky top-[calc(var(--topbar)+1.25rem)] space-y-3">
                    <Panel className="overflow-hidden">
                      <PanelHeader title="On this report" eyebrow="Contents" divider />
                      <nav className="p-2">
                        <ul className="space-y-0.5">
                          {[
                            { href: "#issues", label: "Issues found", count: assessed ? report.summary.fail : 0, tone: "bg-critical" },
                            { href: "#warnings", label: "Needs attention", count: assessed ? report.summary.warn : 0, tone: "bg-medium" },
                            { href: "#inconclusive", label: "Inconclusive", count: report.summary.inconclusive, tone: "bg-low" },
                            { href: "#passed", label: "Observed OK", count: assessed ? report.summary.pass : 0, tone: "bg-pass" },
                            { href: "#transcript", label: "Transcript", count: report.meta.transcript.length, tone: "bg-teal" },
                            { href: "#context", label: "Context", count: contextFindings.length, tone: "bg-line-strong" },
                          ]
                            .filter((item) => item.count > 0)
                            .map((item) => (
                              <li key={item.href}>
                                <a
                                  href={item.href}
                                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] text-soft transition-colors hover:bg-inset hover:text-fg"
                                >
                                  <span aria-hidden="true" className={`size-1.5 rounded-[2px] ${item.tone}`} />
                                  <span className="flex-1">{item.label}</span>
                                  <span className="mono text-[10.5px] text-faint">{item.count}</span>
                                </a>
                              </li>
                            ))}
                        </ul>
                      </nav>
                    </Panel>

                    <Panel className="overflow-hidden">
                      <PanelHeader title="Finding index" eyebrow="All findings" meta={String(report.findings.length)} />
                      <ul className="max-h-[46vh] overflow-y-auto py-1.5">
                        {findingIndex.map((finding) => {
                          const tone = STATUS_TONE[finding.status];
                          return (
                            <li key={finding.id}>
                              <a
                                href={`#finding-${finding.id}`}
                                className="group flex items-start gap-2 px-3.5 py-1.5 text-[11px] leading-4 text-muted transition-colors hover:bg-inset hover:text-fg"
                              >
                                <span
                                  aria-hidden="true"
                                  className={`mt-1 size-1.5 shrink-0 rounded-[2px] ${tone === "critical"
                                      ? "bg-critical"
                                      : tone === "high"
                                        ? "bg-high"
                                        : tone === "medium"
                                          ? "bg-medium"
                                          : tone === "low"
                                            ? "bg-low"
                                            : tone === "pass"
                                              ? "bg-pass/70"
                                              : "bg-line-strong"
                                    }`}
                                />
                                <span className="min-w-0">{finding.title}</span>
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                    </Panel>
                  </div>
                </aside>
              </div>
            ) : (
              <Panel className="p-5">
                <InlineAlert tone="info" title="No findings">
                  This report contains no findings. That is not a security assessment — re-run the scan or review the
                  transcript.
                </InlineAlert>
              </Panel>
            )}

            {/* ── Scope & methodology ────────────────────────────────── */}
            <Panel as="section" id="scope" className="teal-surface scroll-mt-24 px-5 py-5 sm:px-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-[13px] font-medium text-white">
                  <IconShield size={15} className="text-mint" />
                  Scope &amp; methodology
                </h2>
                <Link href="/methodology" className="text-[12px] text-white/70 hover:text-white">
                  Full methodology &amp; limits
                </Link>
              </div>
              <p className="mt-2 max-w-3xl text-[12px] leading-6 text-white/65">
                This report describes configuration observed during a single unauthenticated HTTP(S) request per origin.
                It is not a penetration test, it does not detect application vulnerabilities, and a clean result never
                proves a website is secure. Only submit sites you own or are authorised to test.
              </p>
            </Panel>
          </>
        )}
      </div>
    </>
  );
}

/** Inline summary of which areas produced which outcome, per category. */
function CategoryStrip({ findings }: { findings: Finding[] }) {
  const order = ["headers", "transport", "tls", "cookies", "disclosure"];
  const rows = order
    .map((key) => {
      const items = findings.filter((finding) => finding.category === key);
      return {
        key,
        label: CATEGORY_LABEL[key] ?? key,
        actionable: items.filter((item) => item.status === "fail" || item.status === "warn").length,
        passed: items.filter((item) => item.status === "pass").length,
        total: items.length,
      };
    })
    .filter((row) => row.total > 0);

  if (rows.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {rows.map((row) => (
        <div key={row.key} className="rounded-xl border border-line bg-raised px-3.5 py-3">
          <p className="flex items-center justify-between text-[11px] text-muted">
            {row.label}
            <span className="mono text-[10px] text-faint">{row.total}</span>
          </p>
          <div className="mt-2 flex items-center gap-3">
            <span title="Actionable findings" className={`figure flex items-center gap-1.5 text-[16px] ${row.actionable > 0 ? "text-medium" : "text-faint"}`}>
              {row.actionable}
              <span className="mono text-[9px] tracking-[0.08em] text-faint uppercase">act</span>
            </span>
            <span className="h-3 w-px bg-line-strong" />
            <span title="Controls observed OK" className="figure flex items-center gap-1.5 text-[16px] text-pass">
              {row.passed}
              <span className="mono text-[9px] tracking-[0.08em] text-faint uppercase">ok</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
