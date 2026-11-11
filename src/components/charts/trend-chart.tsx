/**
 * Scan trend — one column group per assessed scan, oldest → newest.
 *
 * Every value is a real report. Failed scans are excluded by the caller: they
 * never observed the target, so they have no finding counts to plot. Columns
 * are used rather than a line because these are discrete, unrelated scans —
 * a line would imply a continuous series the data does not have.
 */

export type TrendPoint = {
  /** ISO timestamp of the scan, used for the axis labels. */
  at: string;
  /** Total actionable findings (fail + warn) in that report. */
  actionable: number;
  /** Controls observed OK in that report. */
  passed: number;
  /** Short host, used in the hover hint. */
  label: string;
  status: "completed" | "inconclusive" | "failed";
};

type Props = {
  points: TrendPoint[];
  label?: string;
};

export function TrendChart({ points, label = "Actionable findings per scan" }: Props) {
  const max = Math.max(1, ...points.map((point) => Math.max(point.actionable, point.passed)));

  const latest = points[points.length - 1];
  const prior = points[points.length - 2];
  const delta = latest && prior ? latest.actionable - prior.actionable : null;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="flex items-center gap-2 text-[11.5px] text-soft">
          <span aria-hidden="true" className="size-2 rounded-[2px] bg-mint" />
          Actionable
        </span>
        <span className="flex items-center gap-2 text-[11.5px] text-soft">
          <span aria-hidden="true" className="size-2 rounded-[2px] bg-teal" />
          Observed OK
        </span>
        {latest ? (
          <span className="mono ml-auto text-[11px] text-faint">
            latest {latest.actionable}
            {delta !== null ? (
              <span className={delta <= 0 ? "text-pass" : "text-medium"}>
                {" "}
                {delta === 0 ? "· no change" : delta < 0 ? `↓ ${Math.abs(delta)}` : `↑ ${delta}`} vs previous
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      <div
        className="mt-4 flex h-[150px] items-end justify-between gap-2 border-b border-line-strong sm:h-[168px]"
        role="img"
        aria-label={`${label}: ${points.map((p) => `${p.label} ${p.actionable} actionable, ${p.passed} observed OK`).join("; ")}`}
      >
        {points.map((point, index) => (
          <div
            key={`${point.at}-${index}`}
            className="group relative flex h-full min-w-0 max-w-[3.25rem] flex-1 items-end justify-center gap-[3px]"
            title={`${point.label} · ${point.actionable} actionable · ${point.passed} observed OK`}
          >
            <span
              className="w-full max-w-[1.15rem] rounded-t-[3px] bg-gradient-to-t from-teal/70 to-mint transition-opacity group-hover:opacity-80"
              style={{
                height: `${Math.max(point.actionable > 0 ? 4 : 0, (point.actionable / max) * 100)}%`,
              }}
            />
            <span
              className="w-full max-w-[1.15rem] rounded-t-[3px] bg-teal/45 transition-opacity group-hover:opacity-80"
              style={{
                height: `${Math.max(point.passed > 0 ? 4 : 0, (point.passed / max) * 100)}%`,
              }}
            />
          </div>
        ))}
      </div>

      <div className="mono mt-2.5 flex items-center justify-between gap-3 text-[10px] text-faint">
        <span className="truncate">{points[0] ? `${points[0].at.slice(0, 10)} · ${points[0].label}` : "—"}</span>
        <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[9.5px] tracking-[0.06em] uppercase">
          peak {max}
        </span>
        <span className="truncate text-right">
          {points.length > 0 ? `${points[points.length - 1].at.slice(0, 10)} · ${points[points.length - 1].label}` : "—"}
        </span>
      </div>
    </div>
  );
}
