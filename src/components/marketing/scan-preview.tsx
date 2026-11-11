import { IconCheck, IconMinus } from "@/components/icons";

/**
 * Illustration of what a SiteSentra report looks like.
 *
 * This is a *static illustration*, not a live scan and not a customer result —
 * it is labelled as such in the UI. The wording mirrors the real finding titles
 * and the real status vocabulary (`Issue found`, `Needs attention`,
 * `Observed OK`) produced by src/lib/scanner/analyze.ts, so it cannot imply a
 * capability the product does not have.
 */

type Row = {
  header: string;
  state: "fail" | "warn" | "pass";
  note: string;
};

const ROWS: Row[] = [
  { header: "Strict-Transport-Security", state: "fail", note: "header not present" },
  { header: "Content-Security-Policy", state: "fail", note: "header not present" },
  { header: "X-Content-Type-Options", state: "fail", note: "header not present" },
  { header: "Referrer-Policy", state: "fail", note: "header not present" },
  { header: "Permissions-Policy", state: "warn", note: "partial policy" },
  { header: "Framing protection", state: "fail", note: "no XFO / frame-ancestors" },
  { header: "TLS 1.3 · certificate chain", state: "pass", note: "verified" },
  { header: "HTTP → HTTPS redirect", state: "pass", note: "301 observed" },
];

const STATE_TONE: Record<Row["state"], { dot: string; label: string; text: string }> = {
  fail: { dot: "bg-critical", label: "Issue found", text: "text-critical" },
  warn: { dot: "bg-medium", label: "Needs attention", text: "text-medium" },
  pass: { dot: "bg-pass", label: "Observed OK", text: "text-pass" },
};

export function ScanPreview() {
  return (
    <div
      className="relative overflow-hidden rounded-3xl border border-line-teal bg-raised shadow-[0_40px_80px_-40px_rgb(0_0_0/1)]"
      aria-label="Illustration of a SiteSentra report"
    >
      <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-mint/[0.08] blur-3xl" />

      {/* Window bar */}
      <div className="relative flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
        </div>
        <span className="mono text-[10px] tracking-[0.12em] text-faint uppercase">report preview</span>
        <span className="mono rounded-full border border-line-teal bg-teal/40 px-2 py-0.5 text-[9.5px] tracking-[0.08em] text-mint uppercase">
          illustration
        </span>
      </div>

      {/* Header */}
      <div className="relative px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mono text-[9.5px] tracking-[0.12em] text-faint uppercase">Assessed target</p>
            <p className="mono mt-1 truncate text-[13.5px] font-medium text-fg">https://example.com</p>
          </div>
          <span className="mono inline-flex shrink-0 items-center gap-1.5 rounded-full border border-pass/30 bg-pass/10 px-2 py-0.5 text-[10.5px] text-pass">
            <span className="size-1.5 rounded-full bg-pass" />
            Completed
          </span>
        </div>

        <div className="mt-4 flex items-end gap-4">
          <div>
            <p className="figure text-[2.5rem] leading-none">5</p>
            <p className="mono mt-1 text-[9.5px] tracking-[0.1em] text-faint uppercase">Actionable</p>
          </div>
          <div className="flex-1 pb-1">
            <div className="flex items-baseline justify-between">
              <span className="mono text-[9.5px] tracking-[0.08em] text-faint uppercase">Severity</span>
              <span className="mono text-[10px] text-faint">3 medium · 2 low</span>
            </div>
            <div className="mt-1.5 flex h-2 gap-px overflow-hidden rounded-full bg-inset">
              <span className="bg-medium" style={{ width: "50%" }} />
              <span className="bg-low" style={{ width: "33%" }} />
              <span className="bg-pass" style={{ width: "17%" }} />
            </div>
          </div>
        </div>
      </div>

      {/* Header checks */}
      <ul className="relative border-t border-line">
        {ROWS.map((row) => {
          const tone = STATE_TONE[row.state];
          return (
            <li key={row.header} className="flex items-center gap-3 border-b border-line/70 px-5 py-2 last:border-b-0">
              <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-[2px] ${tone.dot}`} />
              <span className="mono min-w-0 flex-1 truncate text-[11px] text-soft">{row.header}</span>
              <span className="mono hidden max-w-[8rem] truncate text-[10px] text-faint sm:block">{row.note}</span>
              <span className={`mono hidden w-[6.6rem] shrink-0 text-right text-[10px] md:block ${tone.text}`}>
                {tone.label}
              </span>
              {row.state === "pass" ? (
                <span className="flex size-4 items-center justify-center rounded-full bg-pass/15">
                  <IconCheck size={10} className="text-pass" />
                </span>
              ) : row.state === "warn" ? (
                <span className="flex size-4 items-center justify-center rounded-full bg-medium/15">
                  <IconMinus size={10} className="text-medium" />
                </span>
              ) : (
                <span className="flex size-4 items-center justify-center rounded-full bg-critical/15">
                  <span aria-hidden="true" className="mono text-[9px] text-critical">
                    !
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-inset/40 px-5 py-3">
        <span className="mono text-[10px] text-faint">
          <span className="text-soft">14</span> checks
        </span>
        <span className="mono text-[10px] text-faint">
          <span className="text-soft">3</span> requests
        </span>
        <span className="mono text-[10px] text-faint">
          <span className="text-soft">TLS 1.3</span> negotiated
        </span>
        <span className="mono ml-auto text-[10px] text-mint/80">transcript retained</span>
      </div>
    </div>
  );
}
