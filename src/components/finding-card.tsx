import type { Finding } from "@/lib/scanner/analyze";
import { IconChevronDown } from "@/components/icons";
import { Badge, EvidenceRow } from "@/components/ui";
import {
  CATEGORY_LABEL,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  STATUS_HINT,
  STATUS_LABEL,
  STATUS_TONE,
} from "@/components/severity";

const ACTIONABLE = new Set(["fail", "warn"]);

/**
 * The spine colour encodes the *status* first and the severity second: an
 * `info` finding is never given a severity colour, and a passing control is
 * never shown with a warning tone. This keeps the left edge of the report a
 * reliable index instead of a second badge.
 */
const SPINE: Record<string, string> = {
  fail: "bg-critical",
  warn: "bg-medium",
  inconclusive: "bg-low",
  pass: "bg-pass/60",
  info: "bg-line-strong",
  not_applicable: "bg-line-strong",
};

/** Evidence labels the scanner uses for "what the server actually sent". */
const OBSERVED_LABELS = [
  "Header value",
  "Observed value",
  "First response",
  "Final URL",
  "Negotiated protocol",
  "Protocol",
  "Result",
  "Certificate subject",
  "Redirect response",
];

/** Evidence labels the scanner uses for "here is what would be expected". */
const RECOMMENDED_LABELS = ["Recommended value", "Expected value", "Recommended", "Reference value"];

function findEvidence(finding: Finding, labels: string[]) {
  return finding.evidence.find((item) => labels.some((label) => item.label.toLowerCase() === label.toLowerCase()));
}

/**
 * One finding, rendered as a document section rather than a card:
 *
 *   ▍ MEDIUM   Strict-Transport-Security (HSTS) header          [Issue found]
 *     Security header · finding id
 *     What was checked …
 *     Observed ──────── Recommended ────────
 *     ⌄ Evidence (n) · technical detail · limitations
 *
 * Failures open their evidence by default so the thing that matters is never
 * behind an extra click.
 */
export function FindingCard({ finding, defaultOpen = false }: { finding: Finding; defaultOpen?: boolean }) {
  const actionable = ACTIONABLE.has(finding.status);
  const tone = SEVERITY_TONE[finding.severity];
  const outcomeLabel = STATUS_LABEL[finding.status];

  const observed = findEvidence(finding, OBSERVED_LABELS);
  const recommended = findEvidence(finding, RECOMMENDED_LABELS);
  const hasCompare = Boolean(observed || recommended);
  const compareRows = finding.evidence.filter((item) => item !== observed && item !== recommended);

  return (
    <article
      id={`finding-${finding.id}`}
      className="group/finding relative scroll-mt-24 border-b border-line last:border-b-0"
      data-status={finding.status}
    >
      <span
        aria-hidden="true"
        className={`absolute top-4 bottom-4 left-0 w-[3px] rounded-r-full ${SPINE[finding.status] ?? "bg-line-strong"}`}
      />

      <div className="px-4 py-4 pl-5 sm:px-5 sm:pl-6">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              {actionable ? (
                <Badge tone={tone}>{SEVERITY_LABEL[finding.severity]}</Badge>
              ) : (
                <span className="mono rounded-full border border-line-strong bg-inset px-2 py-0.5 text-[10.5px] text-muted">
                  {outcomeLabel}
                </span>
              )}
              <h3 className="h3">{finding.title}</h3>
            </div>
            <p className="mono mt-1.5 flex flex-wrap items-center gap-x-2 text-[10px] tracking-[0.06em] text-faint uppercase">
              <span>{CATEGORY_LABEL[finding.category] ?? finding.category}</span>
              <span aria-hidden="true" className="text-line-strong">
                /
              </span>
              <span>{finding.id}</span>
            </p>
          </div>
          {actionable ? (
            <span title={STATUS_HINT[finding.status]} className="shrink-0">
              <Badge tone={STATUS_TONE[finding.status]}>{outcomeLabel}</Badge>
            </span>
          ) : null}
        </div>

        <p className="mt-2.5 max-w-3xl text-[12.5px] leading-6 text-soft">{finding.whatWasChecked}</p>

        {/* Observed vs recommended — the core of the finding. */}
        {hasCompare ? (
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
              <dt className="mono text-[9.5px] font-medium tracking-[0.1em] text-faint uppercase">Observed</dt>
              <dd className="mono mt-1.5 text-[11.5px] leading-5 break-words text-soft">
                {observed?.value ?? <span className="font-sans text-faint">Nothing was observed for this check.</span>}
              </dd>
            </div>
            <div className={`rounded-xl border px-3 py-2.5 ${actionable ? "border-mint/20 bg-teal/25" : "border-line bg-panel"}`}>
              <dt className="mono text-[9.5px] font-medium tracking-[0.1em] text-mint/80 uppercase">Recommended</dt>
              <dd className="mono mt-1.5 text-[11.5px] leading-5 break-words text-soft">
                {recommended?.value ?? finding.recommendation ?? <span className="font-sans text-faint">No single value prescribed.</span>}
              </dd>
            </div>
          </dl>
        ) : finding.recommendation ? (
          <div className="mt-3 rounded-xl border border-mint/20 bg-teal/25 px-3 py-2.5">
            <p className="mono text-[9.5px] font-medium tracking-[0.1em] text-mint/80 uppercase">Remediation</p>
            <p className="mt-1 text-[12.5px] leading-6 text-fg">{finding.recommendation}</p>
          </div>
        ) : null}

        <details open={defaultOpen} className="disclosure mt-2.5">
          <summary className="flex items-center gap-2 rounded-lg py-1.5 text-[11.5px] text-muted transition-colors hover:text-fg">
            <IconChevronDown size={13} className="chev text-faint" />
            <span className="font-medium">Evidence &amp; technical detail</span>
            <span className="mono text-[10.5px] text-faint">
              {finding.evidence.length} {finding.evidence.length === 1 ? "item" : "items"}
            </span>
          </summary>
          <div className="mb-3 space-y-3 pt-1">
            {compareRows.length > 0 ? (
              <dl className="overflow-hidden rounded-xl border border-line bg-panel">
                {compareRows.map((item, index) => (
                  <EvidenceRow key={`${item.label}-${index}`} label={item.label} value={item.value} />
                ))}
              </dl>
            ) : null}

            {/* Technical explanation: why the check matters, in the scanner's words. */}
            <div className="rounded-xl border border-line bg-inset/50 px-3 py-2.5">
              <p className="mono text-[9.5px] font-medium tracking-[0.1em] text-faint uppercase">Why this check exists</p>
              <p className="mt-1 text-[12px] leading-5 text-soft">
                A failure here is a concrete misconfiguration observed on the assessed response; a warning means the
                control is present but weaker than it should be. The check is scoped to the response below only.
              </p>
              {finding.recommendation ? (
                <>
                  <p className="mono mt-3 text-[9.5px] font-medium tracking-[0.1em] text-mint/80 uppercase">What to change</p>
                  <p className="mt-1 text-[12px] leading-5 text-fg">{finding.recommendation}</p>
                </>
              ) : null}
            </div>

            <p className="flex gap-2 border-t border-line pt-2.5 text-[11px] leading-5">
              <span className="mono shrink-0 tracking-[0.08em] text-faint uppercase">Limitations</span>
              <span className="text-muted">{finding.limitations}</span>
            </p>
          </div>
        </details>
      </div>
    </article>
  );
}
