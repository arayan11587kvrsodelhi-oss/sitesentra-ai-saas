import type { Finding } from "@/lib/scanner/analyze";
import { SEVERITY_CLASS, SEVERITY_LABEL, STATUS_CLASS, STATUS_HINT, STATUS_LABEL } from "@/components/ui";

/**
 * One finding, rendered with its real evidence.
 * Uses a native <details> element so disclosure works with keyboard and screen
 * readers without custom JavaScript.
 */
export function FindingCard({ finding, defaultOpen = false }: { finding: Finding; defaultOpen?: boolean }) {
  const actionable = finding.status === "fail" || finding.status === "warn";

  return (
    <article
      className={`rounded-lg border bg-ink-900 p-4 sm:p-5 ${
        actionable ? "border-ink-600" : "border-ink-700/70"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold text-mist-100">{finding.title}</h3>
          <p className="text-sm text-mist-500">{finding.whatWasChecked}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CLASS[finding.status]}`}
            title={STATUS_HINT[finding.status]}
          >
            {STATUS_LABEL[finding.status]}
          </span>
          <span
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${SEVERITY_CLASS[finding.severity]}`}
          >
            {SEVERITY_LABEL[finding.severity]}
          </span>
        </div>
      </div>

      <details open={defaultOpen} className="group mt-4">
        <summary className="cursor-pointer list-none text-sm font-medium text-signal-300 marker:hidden hover:text-signal-400">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="transition-transform group-open:rotate-90">
              ▸
            </span>
            Evidence ({finding.evidence.length})
          </span>
        </summary>

        <dl className="mt-3 divide-y divide-ink-800 overflow-hidden rounded-md border border-ink-700 bg-ink-950">
          {finding.evidence.map((item) => (
            <div key={item.label} className="grid gap-1 px-3.5 py-2.5 sm:grid-cols-[minmax(9rem,16rem)_1fr] sm:gap-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-mist-500">{item.label}</dt>
              <dd className="break-words font-mono text-xs leading-relaxed text-mist-200">{item.value}</dd>
            </div>
          ))}
        </dl>
      </details>

      {finding.recommendation ? (
        <div className="mt-4 rounded-md border border-signal-400/25 bg-signal-400/5 p-3.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-signal-300">What to do</p>
          <p className="mt-1.5 text-sm leading-relaxed text-mist-200">{finding.recommendation}</p>
        </div>
      ) : null}

      <p className="mt-4 border-t border-ink-800 pt-3 text-xs leading-relaxed text-mist-500">
        <span className="font-semibold text-mist-400">Limitations: </span>
        {finding.limitations}
      </p>
    </article>
  );
}
