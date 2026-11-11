import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { scanReports } from "@/db/schema";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { HistoryTable, NoMatches } from "@/components/history-table";
import { PageHeader } from "@/components/page-header";
import { Badge, Panel } from "@/components/ui";
import { IconScan } from "@/components/icons";
import { OUTCOME_LABEL, countOf } from "@/components/severity";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Scan history" };

/** Same query the dashboard and /api/scans use: the user's rows, newest first. */
const HISTORY_LIMIT = 50;

type SearchParams = Promise<{ q?: string; status?: string }>;

type StatusFilter = "all" | "completed" | "inconclusive" | "failed";

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "inconclusive", label: "Inconclusive" },
  { value: "failed", label: "Failed" },
];

function buildHref(base: { q?: string; status?: string }, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  const merged = { ...base, ...overrides };
  if (merged.q) params.set("q", merged.q);
  if (merged.status && merged.status !== "all") params.set("status", merged.status);
  const query = params.toString();
  return query ? `/dashboard/history?${query}` : "/dashboard/history";
}

export default async function ScanHistoryPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUserOrRedirect();
  const params = await searchParams;

  const query = (params.q ?? "").trim().slice(0, 120);
  const status: StatusFilter = STATUS_FILTERS.some((filter) => filter.value === params.status)
    ? (params.status as StatusFilter)
    : "all";

  // One query, then filter in memory: the page is already scoped to the
  // session user and capped at HISTORY_LIMIT, so filtering cannot leak rows.
  const scans = await db
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
    .where(eq(scanReports.userId, user.id))
    .orderBy(desc(scanReports.startedAt))
    .limit(HISTORY_LIMIT);

  const needle = query.toLowerCase();
  const visible = scans.filter((scan) => {
    const matchesStatus = status === "all" || scan.status === status;
    if (!matchesStatus) return false;
    if (!needle) return true;
    return (
      scan.inputUrl.toLowerCase().includes(needle) ||
      (scan.targetHost ?? "").toLowerCase().includes(needle) ||
      scan.id.toLowerCase().startsWith(needle) ||
      (scan.failureCode ?? "").toLowerCase().includes(needle)
    );
  });

  const completed = scans.filter((scan) => scan.status === "completed").length;
  const failed = scans.filter((scan) => scan.status === "failed").length;
  const inconclusive = scans.filter((scan) => scan.status === "inconclusive").length;
  // Failed scans never reached the target; their stored summary counts the
  // refusal itself, which is not a finding about the target.
  const issues = scans
    .filter((scan) => scan.status !== "failed")
    .reduce((sum, scan) => sum + countOf(scan.summary, "fail"), 0);
  const filtering = Boolean(needle) || status !== "all";

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="kicker">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
            Workspace
          </span>
        }
        title="Scan history"
        description="Every assessment stored against your account, newest first. Open any report for its findings, observed values and the full request transcript."
        meta={
          <>
            <span className="mono text-[11.5px] text-muted">
              {filtering ? `${visible.length} of ${scans.length}` : `${scans.length}`}
              {scans.length === HISTORY_LIMIT ? " most recent" : ""} {scans.length === 1 ? "report" : "reports"}
            </span>
            {scans.length > 0 ? (
              <>
                <span aria-hidden="true" className="h-3 w-px bg-line-strong" />
                <span className="flex items-center gap-2.5">
                  <Badge tone="pass" dot>
                    {completed} completed
                  </Badge>
                  <Badge tone="medium" dot>
                    {inconclusive} inconclusive
                  </Badge>
                  <Badge tone="critical" dot>
                    {failed} failed
                  </Badge>
                </span>
                <span aria-hidden="true" className="hidden h-3 w-px bg-line-strong sm:block" />
                <span className="mono hidden text-[11.5px] text-faint sm:inline">{issues} issues recorded</span>
              </>
            ) : null}
          </>
        }
        actions={
          <Link href="/dashboard#run-check" className="btn btn-primary gap-1.5">
            <IconScan size={15} />
            New scan
          </Link>
        }
      />

      <div className="px-[var(--gutter)] py-5 sm:py-6">
        <Panel className="overflow-hidden">
          {/* Toolbar: search + status filter, both server-rendered via GET. */}
          <form
            action="/dashboard/history"
            method="get"
            role="search"
            className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-panel px-3 focus-within:border-mint/60 sm:max-w-sm">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="shrink-0 text-faint">
                <circle cx="9" cy="9" r="5.2" />
                <path d="m13 13 3.4 3.4" strokeLinecap="round" />
              </svg>
              <label htmlFor="history-q" className="sr-only">
                Search reports by target, id or failure code
              </label>
              <input
                id="history-q"
                name="q"
                defaultValue={query}
                placeholder="Search target, id or failure code"
                autoComplete="off"
                spellCheck={false}
                className="mono h-9 min-w-0 flex-1 border-0 bg-transparent text-[12px] text-fg placeholder:font-sans placeholder:text-faint focus:outline-none"
              />
              {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="mono hidden text-[10px] tracking-[0.12em] text-faint uppercase sm:inline">Status</span>
              <div className="segmented">
                {STATUS_FILTERS.map((filter) => (
                  <Link
                    key={filter.value}
                    href={buildHref({ q: query || undefined, status }, { status: filter.value })}
                    aria-current={status === filter.value ? "page" : undefined}
                  >
                    {filter.label}
                  </Link>
                ))}
              </div>
              <button type="submit" className="btn btn-secondary btn-sm">
                Search
              </button>
            </div>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 sm:px-5">
            <p className="mono text-[10.5px] text-faint">
              {filtering
                ? `Filtered view${needle ? ` · “${query}”` : ""}${status !== "all" ? ` · ${OUTCOME_LABEL[status]}` : ""}`
                : `Showing ${scans.length}${scans.length === HISTORY_LIMIT ? " most recent" : ""} ${scans.length === 1 ? "report" : "reports"}`}
            </p>
            {filtering ? (
              <Link href="/dashboard/history" className="text-[11.5px] text-soft underline decoration-line-strong underline-offset-2 hover:text-mint">
                Clear filters
              </Link>
            ) : (
              <span className="mono text-[10.5px] text-faint">Newest first</span>
            )}
          </div>

          <HistoryTable scans={visible} empty={filtering ? <NoMatches resetHref="/dashboard/history" /> : undefined} />
        </Panel>

        <p className="mt-4 px-1 text-[11px] leading-5 text-faint">
          Reports are ordered by start time and capped at {HISTORY_LIMIT} per view. Search and status filtering apply to
          those stored reports only.
        </p>
      </div>
    </>
  );
}
