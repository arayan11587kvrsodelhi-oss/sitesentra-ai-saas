/**
 * SiteSentra — scan orchestration and persistence.
 *
 * Order of operations matters for safety:
 *   quota → concurrency slot → URL validation → pinned fetch → analysis → store
 * A refused target still consumes quota (it costs a request) but never opens a
 * socket, and is stored as a failed scan so it can never be mistaken for a
 * passing assessment.
 */
import { db } from "@/db";
import { scanReports, type ScanStatus, type User } from "@/db/schema";
import {
  analyseObservation,
  analyseRejection,
  type Finding,
  type FindingSummary,
  type ObservedHop,
  type ScanOutcome,
  parseSetCookie,
} from "@/lib/scanner/analyze";
import { observeTarget, getScannerLimits } from "@/lib/scanner/http-client";
import { isTargetRejected } from "@/lib/scanner/target-guard";
import { acquireScanSlot, checkScanRateLimit, releaseScanSlot } from "@/lib/rate-limit";
import { newId } from "@/lib/auth/password";

export const REPORT_VERSION = 1;

export type ScanLimitError = {
  kind: "rate-limited" | "busy" | "server-busy";
  message: string;
  retryAfterSeconds: number;
};

export type RunScanResult =
  | { ok: true; reportId: string; outcome: ScanOutcome }
  | { ok: false; error: ScanLimitError };

export type StoredReport = {
  version: number;
  outcome: ScanOutcome;
  assessedUrl: string | null;
  findings: Finding[];
  summary: FindingSummary;
  failure: { code: string | null; message: string | null };
  meta: {
    inputUrl: string;
    requestedUrl: string;
    requestedScheme: string;
    userAgent: string;
    scannedAt: string;
    durationMs: number;
    validatedAddresses: string[];
    /** Redacted transcript of every hop we observed. */
    transcript: Array<{
      probe: "requested" | "https" | "http";
      url: string;
      scheme: string;
      statusCode: number | null;
      responseTimeMs: number;
      headers: Record<string, string[]>;
      cookies: string[];
      tls: ObservedHop["tls"];
      error: ObservedHop["error"];
    }>;
  };
};

/**
 * Strip anything sensitive before evidence is written to the database.
 * Set-Cookie *values* are frequently session secrets: we keep the cookie name
 * and its security attributes, and nothing else.
 */
function redactHeaders(hop: ObservedHop): { headers: Record<string, string[]>; cookies: string[] } {
  const headers: Record<string, string[]> = {};
  const cookies: string[] = [];
  for (const [name, values] of Object.entries(hop.headers)) {
    if (name.toLowerCase() === "set-cookie") {
      for (const value of values) {
        const parsed = parseSetCookie(value);
        cookies.push(
          `${parsed.name}: ${[
            parsed.secure ? "Secure" : "no-Secure",
            parsed.httpOnly ? "HttpOnly" : "no-HttpOnly",
            parsed.sameSite ? `SameSite=${parsed.sameSite}` : "no-SameSite",
          ].join(", ")}`,
        );
      }
      headers["set-cookie"] = [`[${values.length} cookie header(s) redacted — attributes recorded separately]`];
      continue;
    }
    headers[name] = values.map((v) => (v.length > 800 ? `${v.slice(0, 800)}…[truncated]` : v));
  }
  return { headers, cookies };
}

function buildTranscript(observation: {
  primaryChain: ObservedHop[];
  httpsChain: ObservedHop[];
  httpChain: ObservedHop[];
  inputUrl: string;
  requestedUrl: string;
  requestedScheme: string;
  userAgent: string;
  scannedAt: string;
  totalDurationMs: number;
  resolvedAddresses: string[];
}): StoredReport["meta"] {
  const transcript: StoredReport["meta"]["transcript"] = [];
  const push = (probe: "requested" | "https" | "http", hops: ObservedHop[]) => {
    for (const hop of hops) {
      const { headers, cookies } = redactHeaders(hop);
      transcript.push({
        probe,
        url: hop.url,
        scheme: hop.scheme,
        statusCode: hop.statusCode,
        responseTimeMs: hop.responseTimeMs,
        headers,
        cookies,
        tls: hop.tls,
        error: hop.error,
      });
    }
  };
  // The chain for the requested scheme is labelled "requested"; the other
  // probe is labelled with its own scheme. Nothing is duplicated.
  push("requested", observation.primaryChain);
  if (observation.requestedScheme !== "https:") push("https", observation.httpsChain);
  else push("http", observation.httpChain);

  return {
    inputUrl: observation.inputUrl,
    requestedUrl: observation.requestedUrl,
    requestedScheme: observation.requestedScheme,
    userAgent: observation.userAgent,
    scannedAt: observation.scannedAt,
    durationMs: observation.totalDurationMs,
    validatedAddresses: observation.resolvedAddresses,
    transcript,
  };
}

export async function runScanForUser(user: User, rawUrl: string): Promise<RunScanResult> {
  const quota = await checkScanRateLimit(user.id);
  if (!quota.allowed) {
    return {
      ok: false,
      error: {
        kind: "rate-limited",
        message: `Scan quota reached: ${quota.limit} scans per ${quota.windowMinutes} minutes. Your previous scans remain available in history.`,
        retryAfterSeconds: quota.retryAfterSeconds,
      },
    };
  }

  const slot = acquireScanSlot(user.id);
  if (!slot.ok) {
    return {
      ok: false,
      error: {
        kind: slot.reason === "user-busy" ? "busy" : "server-busy",
        message:
          slot.reason === "user-busy"
            ? "You already have a scan running. Wait for it to finish before starting another."
            : "The scanner is currently at capacity. Please try again in a moment.",
        retryAfterSeconds: 10,
      },
    };
  }

  const startedAt = new Date();
  let report: StoredReport;
  let outcome: ScanOutcome;
  let failureCode: string | null = null;
  let failureMessage: string | null = null;
  let summary: FindingSummary;
  let normalizedUrl: string | null = null;
  let targetHost: string | null = null;
  let resolvedAddresses: string[] = [];

  try {
    try {
      const observation = await observeTarget(rawUrl, getScannerLimits());
      const analysis = analyseObservation(observation);
      outcome = analysis.status;
      failureCode = analysis.failureCode;
      failureMessage = analysis.failureMessage;
      summary = analysis.summary;
      normalizedUrl = observation.requestedUrl;
      targetHost = new URL(observation.requestedUrl).hostname;
      resolvedAddresses = observation.resolvedAddresses;
      report = {
        version: REPORT_VERSION,
        outcome,
        assessedUrl: analysis.assessedUrl,
        findings: analysis.findings,
        summary: analysis.summary,
        failure: { code: failureCode, message: failureMessage },
        meta: buildTranscript(observation),
      };
    } catch (error) {
      // Target refused by the SSRF policy, or an unexpected internal failure.
      // Either way: nothing is claimed about the target's security.
      const rejected = isTargetRejected(error);
      const code = rejected ? error.code : "scan-error";
      const message = rejected
        ? error.message
        : "The scan could not be completed because of an unexpected error. No security conclusion was drawn.";
      const scannedAt = startedAt.toISOString();
      const analysis = analyseRejection({ inputUrl: rawUrl.slice(0, 2048), code, message, scannedAt });
      outcome = analysis.status;
      failureCode = code;
      failureMessage = message;
      summary = analysis.summary;
      try {
        const parsed = new URL(rawUrl);
        targetHost = parsed.hostname;
        normalizedUrl = parsed.origin + parsed.pathname;
      } catch {
        targetHost = null;
        normalizedUrl = null;
      }
      report = {
        version: REPORT_VERSION,
        outcome,
        assessedUrl: null,
        findings: analysis.findings,
        summary: analysis.summary,
        failure: { code, message },
        meta: {
          inputUrl: rawUrl.slice(0, 2048),
          requestedUrl: normalizedUrl ?? rawUrl.slice(0, 2048),
          requestedScheme: targetHost ? "unknown" : "unknown",
          userAgent: "not sent — target refused before any request",
          scannedAt,
          durationMs: Date.now() - startedAt.getTime(),
          validatedAddresses: [],
          transcript: [],
        },
      };
    }

    const [inserted] = await db
      .insert(scanReports)
      .values({
        id: newId(),
        userId: user.id,
        inputUrl: rawUrl.slice(0, 2048),
        normalizedUrl,
        targetHost,
        resolvedAddresses,
        status: outcome as ScanStatus,
        failureCode,
        failureMessage,
        report: report as unknown as Record<string, unknown>,
        summary: summary as unknown as Record<string, number>,
        durationMs: Date.now() - startedAt.getTime(),
        startedAt,
        finishedAt: new Date(),
      })
      .returning({ id: scanReports.id });

    return { ok: true, reportId: inserted.id, outcome };
  } finally {
    releaseScanSlot(user.id);
  }
}

export function parseStoredReport(raw: unknown): StoredReport | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<StoredReport>;
  if (!Array.isArray(candidate.findings) || !candidate.summary || typeof candidate.version !== "number") {
    return null;
  }
  return candidate as StoredReport;
}
