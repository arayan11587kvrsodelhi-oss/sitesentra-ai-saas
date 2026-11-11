/**
 * Findings by area (transport / TLS / headers / cookies / disclosure).
 *
 * Two quantities per row, both counted from the same stored reports:
 * actionable (fail + warn) and observed-OK controls. The bar is drawn against
 * the largest area's total, so relative size is visible; a category with no
 * findings at all keeps a visible track rather than a zero-length bar, which
 * would be indistinguishable from a rendering failure.
 */
export type CategoryRow = {
  key: string;
  label: string;
  actionable: number;
  passed: number;
};

export function CategoryBars({ rows }: { rows: CategoryRow[] }) {
  const max = Math.max(1, ...rows.map((row) => row.actionable + row.passed));

  return (
    <ul className="space-y-4">
      {rows.map((row) => {
        const total = row.actionable + row.passed;
        const actionablePct = (row.actionable / max) * 100;
        const passedPct = (row.passed / max) * 100;
        return (
          <li key={row.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[12px] text-soft">{row.label}</span>
              <span className="mono flex items-baseline gap-1 text-[10.5px] tabular-nums">
                <span className={row.actionable > 0 ? "text-medium" : "text-faint"}>{row.actionable}</span>
                <span className="text-line-strong">/</span>
                <span className="text-pass">{row.passed}</span>
              </span>
            </div>
            <div
              className="mt-1.5 flex h-2 w-full items-center gap-px overflow-hidden rounded-full bg-inset ring-1 ring-inset ring-line-strong/40"
              role="img"
              aria-label={`${row.label}: ${row.actionable} actionable, ${row.passed} observed OK`}
            >
              {total === 0 ? (
                <span className="h-[3px] w-1.5 rounded-full bg-line-strong" />
              ) : (
                <>
                  {actionablePct > 0 ? (
                    <span className="h-full bg-medium" style={{ width: `${actionablePct}%` }} />
                  ) : null}
                  {passedPct > 0 ? (
                    <span className="h-full bg-teal" style={{ width: `${passedPct}%` }} />
                  ) : null}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
