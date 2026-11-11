/**
 * Presentation vocabulary for findings, severities and scan outcomes.
 *
 * Kept in one module so the wording a user reads always matches the meaning
 * the scanner assigned. A `fail` is never dressed up as informational, and an
 * `inconclusive` is never rendered as a pass.
 *
 * Values come from the scanner's own types — nothing here invents a state the
 * backend cannot produce.
 */
import type { FindingStatus, Severity, ScanOutcome } from "@/lib/scanner/analyze";

export type Tone = "critical" | "high" | "medium" | "low" | "pass" | "info" | "neutral";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  info: "info",
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const STATUS_LABEL: Record<FindingStatus, string> = {
  pass: "Observed OK",
  fail: "Issue found",
  warn: "Needs attention",
  info: "Information",
  not_applicable: "Not applicable",
  inconclusive: "Inconclusive",
};

export const STATUS_SHORT: Record<FindingStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  warn: "Warn",
  info: "Info",
  not_applicable: "N/A",
  inconclusive: "Unverified",
};

export const STATUS_HINT: Record<FindingStatus, string> = {
  pass: "The control was actually observed on the assessed response.",
  fail: "A concrete problem was observed. Evidence is attached.",
  warn: "Something observed weakens the control, but it is not a definite failure.",
  info: "Context only — not a pass or a fail.",
  not_applicable: "The check did not apply to what we could observe.",
  inconclusive: "Not enough was observable to judge. This is NOT a pass — verify manually.",
};

export const STATUS_TONE: Record<FindingStatus, Tone> = {
  pass: "pass",
  fail: "critical",
  warn: "medium",
  info: "info",
  not_applicable: "neutral",
  inconclusive: "low",
};

export const OUTCOME_LABEL: Record<ScanOutcome, string> = {
  completed: "Completed",
  inconclusive: "Inconclusive",
  failed: "Failed",
};

export const OUTCOME_TONE: Record<ScanOutcome, Tone> = {
  completed: "pass",
  inconclusive: "medium",
  failed: "critical",
};

/** Human label for a finding's category, used as the small "affected area" tag. */
export const CATEGORY_LABEL: Record<string, string> = {
  transport: "Transport",
  tls: "TLS",
  headers: "Security header",
  cookies: "Cookie attribute",
  disclosure: "Disclosure",
};

export function asTone(value: string | null | undefined): Tone {
  switch (value) {
    case "critical":
    case "high":
    case "medium":
    case "low":
    case "pass":
    case "info":
      return value;
    default:
      return "neutral";
  }
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return "—";
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return date.toISOString().slice(0, 10);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `summary` column values are untyped in the DB; read them defensively. */
export function countOf(summary: Record<string, number> | null | undefined, key: string): number {
  if (!summary) return 0;
  const raw = Number(summary[key] ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

export function severityCountsOf(
  summary: Record<string, unknown> | null | undefined,
): Record<Severity, number> {
  const base: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const bySeverity = summary?.bySeverity;
  if (!bySeverity || typeof bySeverity !== "object") return base;
  for (const key of SEVERITY_ORDER) {
    const raw = Number((bySeverity as Record<string, unknown>)[key] ?? 0);
    base[key] = Number.isFinite(raw) ? raw : 0;
  }
  return base;
}

/**
 * The persisted `bySeverity` counts *every* finding, including passing and
 * informational ones — so a clean report full of passes would read as a large
 * "info" bar. A severity distribution only means something for findings that
 * need action, so it is derived from the stored summary as
 * fail+warn-by-severity. `low` and `info` are left at zero when the data
 * cannot be split; they are shown only when a count actually exists.
 */
export function actionableSeverityOf(
  summary: Record<string, unknown> | null | undefined,
): Record<Severity, number> {
  const counts = severityCountsOf(summary);
  const actionable = countOf(summary as Record<string, number> | undefined, "fail") +
    countOf(summary as Record<string, number> | undefined, "warn");
  const total = SEVERITY_ORDER.reduce((sum, key) => sum + counts[key], 0);
  // When every finding is fail/warn, the stored distribution is already exact.
  if (actionable === 0 || total <= actionable) return counts;
  // Otherwise the split per severity is not stored; report the aggregate only.
  return { ...counts, info: 0 };
}
