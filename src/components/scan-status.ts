/**
 * Backwards-compatible re-export of the finding/severity vocabulary.
 * The canonical definitions live in `src/components/severity.ts`.
 */
import type { FindingStatus, Severity } from "@/lib/scanner/analyze";
import { STATUS_TONE, SEVERITY_TONE, OUTCOME_TONE } from "@/components/severity";

export {
  STATUS_LABEL,
  STATUS_HINT,
  SEVERITY_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  formatDate,
  formatDuration,
} from "@/components/severity";

const TONE_CLASS: Record<string, string> = {
  critical: "border-critical/35 bg-critical/10 text-critical",
  high: "border-high/35 bg-high/10 text-high",
  medium: "border-medium/35 bg-medium/10 text-medium",
  low: "border-low/35 bg-low/10 text-low",
  pass: "border-pass/35 bg-pass/10 text-pass",
  info: "border-info/30 bg-info/10 text-info",
  neutral: "border-line-strong bg-inset text-soft",
};

export const STATUS_CLASS: Record<FindingStatus, string> = {
  pass: TONE_CLASS.pass,
  fail: TONE_CLASS.critical,
  warn: TONE_CLASS.medium,
  info: TONE_CLASS.info,
  not_applicable: TONE_CLASS.neutral,
  inconclusive: TONE_CLASS.low,
};

export const SEVERITY_CLASS: Record<Severity, string> = {
  critical: TONE_CLASS.critical,
  high: TONE_CLASS.high,
  medium: TONE_CLASS.medium,
  low: TONE_CLASS.low,
  info: TONE_CLASS.info,
};

export const OUTCOME_CLASS: Record<string, string> = {
  completed: TONE_CLASS.pass,
  inconclusive: TONE_CLASS.medium,
  failed: TONE_CLASS.critical,
};

export { STATUS_TONE, SEVERITY_TONE };
