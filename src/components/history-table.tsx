import Link from "next/link";
import type { ReactNode } from "react";

import { IconArrowRight, IconChevronRight, IconScan } from "@/components/icons";
import { Badge, DistributionBar, EmptyState, SeverityDot } from "@/components/ui";
import {
  OUTCOME_LABEL,
  OUTCOME_TONE,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  SEVERITY_TONE,
  countOf,
  formatDate,
  formatDuration,
  formatRelative,
  severityCountsOf,
} from "@/components/severity";

export type HistoryScan = {
  id: string;
  inputUrl: string;
  targetHost: string | null;
  status: string;
  summary: Record<string, number> | null;
  failureCode: string | null;
  durationMs: number | null;
  startedAt: Date;
};

function outcomeOf(status: string): keyof typeof OUTCOME_LABEL {
  return status === "completed" || status === "inconclusive" ? status : "failed";
}

function distributionFor(scan: HistoryScan) {
  return SEVERITY_ORDER.map((severity) => ({
    key: severity,
    label: SEVERITY_LABEL[severity],
    count: severityCountsOf(scan.summary)[severity],
    tone: SEVERITY_TONE[severity],
  }));
}

/** Highest severity present on this scan, for the dense colour marker. */
function dominantSeverity(scan: HistoryScan) {
  const counts = severityCountsOf(scan.summary);
  const present = SEVERITY_ORDER.find((severity) => counts[severity] > 0);
  return present ?? null;
}

function targetOf(scan: HistoryScan) {
  return scan.targetHost ?? scan.inputUrl;
}

/**
 * A scan that never assessed the target cannot report findings. The stored
 * summary of such a scan still counts its own refusal (severity "info"), so
 * the row must show no counts rather than borrowing that number as an issue.
 */
function countIfAssessed(scan: HistoryScan, key: "fail" | "warn" | "pass"): number | null {
  if (scan.status === "failed") return null;
  return countOf(scan.summary, key);
}

function CountCell({ value, tone }: { value: number | null; tone: string }) {
  if (value === null) return <span className="text-faint">—</span>;
  return <span className={value > 0 ? tone : "text-faint"}>{value}</span>;
}



export function EmptyHistory() {
  return (
    <EmptyState
      icon={<IconScan size={18} />}
      title="No reports yet"
      description="Run a check from the overview page. Your first report appears here with its severity breakdown and a link to the full evidence trail."
      action={
        <Link href="/dashboard#run-check" className="btn btn-primary btn-sm gap-1.5">
          Run your first scan
          <IconArrowRight size={13} />
        </Link>
      }
    />
  );
}

/** "No report matches these filters" — distinct from "you have no data". */
export function NoMatches({ resetHref }: { resetHref: string }) {
  return (
    <EmptyState
      title="No reports match this view"
      description="Adjust the search term or status filter. Your stored reports are unchanged."
      action={
        <Link href={resetHref} className="btn btn-secondary btn-sm">
          Clear filters
        </Link>
      }
    />
  );
}

/**
 * Desktop: a dense table. Below `lg`: stacked cards with the same information.
 * Both read from the same real records — nothing is summarised away.
 * `compact` drops the secondary columns for the dashboard's activity panel.
 */
export function HistoryTable({
  scans,
  variant = "full",
  empty,
}: {
  scans: HistoryScan[];
  variant?: "full" | "compact";
  empty?: ReactNode;
}) {
  if (scans.length === 0) return <>{empty ?? <EmptyHistory />}</>;

  const compact = variant === "compact";

  return (
    <>
      <div className="hidden lg:block">
        <table className="data-table table-fixed">
          <caption className="sr-only">Scan reports, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Target</th>
              <th scope="col" className="w-[8.5rem]">
                Status
              </th>
              {!compact ? (
                <th scope="col" className="w-[9.5rem]">
                  Severity
                </th>
              ) : null}
              <th scope="col" className="w-[4.5rem] text-right">
                Issues
              </th>
              <th scope="col" className="w-[6.5rem] text-right">
                Warnings
              </th>
              {!compact ? (
                <th scope="col" className="w-[6.5rem] text-right">
                  OK
                </th>
              ) : null}
              {!compact ? (
                <th scope="col" className="hidden w-[6rem] text-right xl:table-cell">
                  Duration
                </th>
              ) : null}
              <th scope="col" className="w-[7.5rem] text-right">
                Started
              </th>
              <th scope="col" className="w-10">
                <span className="sr-only">Open report</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {scans.map((scan) => {
              const outcome = outcomeOf(scan.status);
              const severity = dominantSeverity(scan);
              return (
                <tr key={scan.id} className="group">
                  <td className="overflow-hidden">
                    <Link href={`/dashboard/scans/${scan.id}`} className="flex items-center gap-2.5">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-inset">
                        {severity ? (
                          <SeverityDot tone={SEVERITY_TONE[severity]} />
                        ) : (
                          <span className="size-1.5 rounded-[2px] bg-line-strong" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="mono block truncate text-[12.5px] font-medium text-fg group-hover:text-mint" title={scan.inputUrl}>
                          {targetOf(scan)}
                        </span>
                        <span className="mono block truncate text-[10.5px] text-faint" title={scan.inputUrl}>
                          {scan.failureCode ?? scan.inputUrl}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td>
                    <Badge tone={OUTCOME_TONE[outcome]} dot>
                      {OUTCOME_LABEL[outcome]}
                    </Badge>
                  </td>
                  {!compact ? (
                    <td>
                      {severity ? (
                        <DistributionBar items={distributionFor(scan)} showLegend={false} height={6} label="Severity" />
                      ) : (
                        <span className="mono text-[10px] text-faint">—</span>
                      )}
                    </td>
                  ) : null}
                  <td className="mono text-right tabular-nums">
                    <CountCell value={countIfAssessed(scan, "fail")} tone="text-critical" />
                  </td>
                  <td className="mono text-right tabular-nums">
                    <CountCell value={countIfAssessed(scan, "warn")} tone="text-medium" />
                  </td>
                  {!compact ? (
                    <td className="mono text-right text-soft tabular-nums">
                      <CountCell value={countIfAssessed(scan, "pass")} tone="text-soft" />
                    </td>
                  ) : null}
                  {!compact ? (
                    <td className="mono hidden text-right text-[12px] text-muted xl:table-cell">
                      {formatDuration(scan.durationMs)}
                    </td>
                  ) : null}
                  <td className="text-right">
                    <time
                      dateTime={scan.startedAt.toISOString()}
                      title={formatDate(scan.startedAt)}
                      className="mono text-[11.5px] text-muted"
                    >
                      {formatRelative(scan.startedAt)}
                    </time>
                  </td>
                  <td className="pr-4">
                    <Link
                      href={`/dashboard/scans/${scan.id}`}
                      aria-label={`Open report for ${targetOf(scan)}`}
                      className="flex size-7 items-center justify-center rounded-full text-faint transition-colors group-hover:bg-inset group-hover:text-mint"
                    >
                      <IconChevronRight size={15} />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Tablet & mobile */}
      <ul className="divide-y divide-line lg:hidden">
        {scans.map((scan) => {
          const outcome = outcomeOf(scan.status);
          const severity = dominantSeverity(scan);
          return (
            <li key={scan.id}>
              <Link href={`/dashboard/scans/${scan.id}`} className="block px-4 py-4 transition-colors active:bg-hover sm:px-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-inset">
                    {severity ? <SeverityDot tone={SEVERITY_TONE[severity]} /> : <span className="size-1.5 rounded-[2px] bg-line-strong" />}
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{targetOf(scan)}</span>
                  <Badge tone={OUTCOME_TONE[outcome]} dot>
                    {OUTCOME_LABEL[outcome]}
                  </Badge>
                </div>
                <div className="mt-3 flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    {severity ? (
                      <DistributionBar items={distributionFor(scan)} showLegend={false} height={5} label="Severity" />
                    ) : (
                      <p className="mono truncate text-[10px] text-faint">{scan.failureCode ?? "no findings recorded"}</p>
                    )}
                  </div>
                  <span className="mono shrink-0 text-[10.5px] text-faint">{formatRelative(scan.startedAt)}</span>
                </div>
                <div className="mono mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                  {scan.status === "failed" ? (
                    <span className="text-faint">Not assessed — no counts</span>
                  ) : (
                    <>
                      <span>
                        <CountCell value={countIfAssessed(scan, "fail")} tone="text-critical" /> issues
                      </span>
                      <span className="text-line-strong">·</span>
                      <span>
                        <CountCell value={countIfAssessed(scan, "warn")} tone="text-medium" /> warnings
                      </span>
                      <span className="text-line-strong">·</span>
                      <span>{countIfAssessed(scan, "pass")} ok</span>
                    </>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1 text-mint">
                    Report <IconChevronRight size={11} />
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
