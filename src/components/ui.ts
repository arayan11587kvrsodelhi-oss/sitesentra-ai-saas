/**
 * Presentation vocabulary shared by the UI: labels and colour classes for
 * finding statuses and severities.
 *
 * Kept in one place so the wording a user sees always matches the meaning the
 * scanner assigned — a `fail` is never rendered as if it were informational.
 */
import type { FindingStatus, Severity } from "@/lib/scanner/analyze";

export const STATUS_LABEL: Record<FindingStatus, string> = {
  pass: "Observed OK",
  fail: "Issue found",
  warn: "Needs attention",
  info: "Information",
  not_applicable: "Not applicable",
  inconclusive: "Inconclusive",
};

export const STATUS_HINT: Record<FindingStatus, string> = {
  pass: "The control was actually observed on the assessed response.",
  fail: "A concrete problem was observed. Evidence is attached.",
  warn: "Something observed weakens the control, but it is not a definite failure.",
  info: "Context only — not a pass or a fail.",
  not_applicable: "The check did not apply to what we could observe.",
  inconclusive:
    "We could not observe enough to judge this. This is NOT a pass — verify manually.",
};

export const STATUS_CLASS: Record<FindingStatus, string> = {
  pass: "border-ok-400/30 bg-ok-400/10 text-ok-400",
  fail: "border-bad-400/30 bg-bad-400/10 text-bad-400",
  warn: "border-warn-400/30 bg-warn-400/10 text-warn-400",
  info: "border-ink-600 bg-ink-800 text-mist-300",
  not_applicable: "border-ink-600 bg-ink-850 text-mist-500",
  inconclusive: "border-signal-400/30 bg-signal-400/10 text-signal-300",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export const SEVERITY_CLASS: Record<Severity, string> = {
  critical: "border-crit-400/40 bg-crit-400/10 text-crit-400",
  high: "border-bad-400/40 bg-bad-400/10 text-bad-400",
  medium: "border-warn-400/40 bg-warn-400/10 text-warn-400",
  low: "border-signal-400/30 bg-signal-400/10 text-signal-300",
  info: "border-ink-600 bg-ink-800 text-mist-400",
};

export const OUTCOME_LABEL: Record<string, string> = {
  completed: "Completed",
  inconclusive: "Inconclusive",
  failed: "Failed",
};

export const OUTCOME_CLASS: Record<string, string> = {
  completed: "border-ok-400/30 bg-ok-400/10 text-ok-400",
  inconclusive: "border-signal-400/30 bg-signal-400/10 text-signal-300",
  failed: "border-bad-400/30 bg-bad-400/10 text-bad-400",
};

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
