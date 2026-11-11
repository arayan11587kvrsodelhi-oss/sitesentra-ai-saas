"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type SyntheticEvent } from "react";

import { IconAlert, IconArrowRight, IconScan } from "@/components/icons";

type RecentTarget = { host: string; url: string; count: number; lastAt: string };

type Props = {
  remaining: number;
  limit: number;
  windowMinutes: number;
  /** Pre-filled target (the landing page carries the typed URL here). */
  defaultUrl?: string;
  /** Distinct hosts from this account's stored reports, most recent first. */
  recentTargets?: RecentTarget[];
};

/**
 * Add an explicit scheme when the user typed a bare hostname.
 * The server refuses scheme-less URLs on purpose (they are ambiguous), so the
 * UI makes the choice visible instead of the server guessing.
 */
export function normaliseUrlInput(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/[^\s]*)?$/.test(value)) return `https://${value}`;
  return null;
}

/**
 * The dashboard scan workspace. Same request contract as before
 * (`POST /api/scans { url }`), same success behaviour (navigate to the report).
 * Composition: one command bar on desktop, stacked on mobile, with the recent
 * targets from the account's own history underneath as shortcuts.
 */
export function ScanForm({ remaining, limit, windowMinutes, defaultUrl = "", recentTargets = [] }: Props) {
  const router = useRouter();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const statusId = `${inputId}-status`;

  // The prefill arrives from a URL parameter; only accept something the form
  // would itself submit (→ http/https), never `javascript:` or similar.
  const [url, setUrl] = useState(() => {
    const normalised = normaliseUrlInput(defaultUrl);
    return normalised && /^https?:\/\//i.test(normalised) ? normalised : "";
  });
  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const quotaExhausted = remaining <= 0;
  const usedRatio = limit > 0 ? Math.min(1, (limit - remaining) / limit) : 0;

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "running" || quotaExhausted) return;

    const target = normaliseUrlInput(url);
    if (!target) {
      setPhase("error");
      setMessage("Enter a public website URL, for example https://example.com or example.com.");
      return;
    }

    setPhase("running");
    setMessage(null);
    setElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.round((Date.now() - startedAt) / 1000));
    }, 250);

    try {
      const response = await fetch("/api/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; reportId?: string; error?: { message?: string } }
        | null;

      if (!response.ok || !data?.ok || !data.reportId) {
        setPhase("error");
        setMessage(
          data?.error?.message ??
          `The scan did not complete (HTTP ${response.status}). No security conclusion was drawn.`,
        );
        return;
      }

      router.push(`/dashboard/scans/${data.reportId}`);
      router.refresh();
    } catch {
      setPhase("error");
      setMessage("Network error while running the scan. Nothing was recorded — please try again.");
    } finally {
      window.clearInterval(timer);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <label htmlFor={inputId} className="block text-[12px] font-medium text-soft">
        Website to assess
      </label>

      <div
        data-invalid={phase === "error" ? "true" : undefined}
        data-busy={phase === "running" ? "true" : undefined}
        className="group relative flex flex-col gap-2 rounded-2xl border border-line-strong bg-panel p-2 transition-colors focus-within:border-mint/60 data-[busy=true]:border-teal data-[invalid=true]:border-critical sm:flex-row sm:items-center sm:rounded-full sm:pl-4"
      >
        <span aria-hidden="true" className="mono hidden shrink-0 items-center gap-2 pr-3 text-[11px] tracking-[0.08em] text-mint uppercase select-none sm:flex">
          <span className="size-1.5 rounded-full bg-mint" />
          https
        </span>

        <input
          id={inputId}
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="example.com"
          title="Enter a public URL, for example https://example.com"
          value={url}
          disabled={phase === "running" || quotaExhausted}
          onChange={(event) => {
            setUrl(event.target.value);
            if (phase === "error") {
              setPhase("idle");
              setMessage(null);
            }
          }}
          aria-describedby={`${hintId}${phase === "error" ? ` ${errorId}` : ""}`}
          aria-invalid={phase === "error" ? true : undefined}
          className="mono h-11 w-full min-w-0 flex-1 border-0 bg-transparent px-3 text-[14px] text-fg placeholder:truncate placeholder:font-sans placeholder:text-faint focus:outline-none disabled:opacity-60 sm:h-10 sm:px-0"
        />

        <button
          type="submit"
          disabled={phase === "running" || quotaExhausted}
          className="btn btn-primary h-11 shrink-0 gap-2 px-5 sm:h-11 sm:min-w-[10.75rem]"
        >
          {phase === "running" ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <span className="mono text-[12.5px]">Scanning {elapsedSeconds}s</span>
            </>
          ) : (
            <>
              <IconScan size={16} />
              Run scan
            </>
          )}
        </button>
      </div>

      {phase === "error" && message ? (
        <p id={errorId} role="alert" className="flex items-start gap-2 rounded-xl border border-critical/30 bg-critical/[0.07] px-3 py-2 text-[12px] leading-5 text-critical">
          <IconAlert size={14} className="mt-0.5 shrink-0" />
          {message}
        </p>
      ) : null}

      <p id={hintId} className="text-[11.5px] leading-5 text-faint">
        Public <span className="mono text-muted">http://</span> or <span className="mono text-muted">https://</span> URLs on
        the default port. Internal addresses, IP-literal tricks, non-default ports and embedded credentials are refused
        before any request is sent.
      </p>

      {/* Quota strip */}
      <div
        aria-live="polite"
        aria-atomic="true"
        id={statusId}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-inset/60 px-3.5 py-2.5"
      >
        {phase === "running" ? (
          <p className="flex items-center gap-2 text-[12px] text-soft">
            <span className="pulse-dot text-mint" aria-hidden="true" />
            Contacting the target and reading its real responses… do not close this tab.
          </p>
        ) : quotaExhausted ? (
          <p className="flex items-center gap-2 text-[12px] text-medium">
            <IconAlert size={14} className="shrink-0" />
            Scan quota reached ({limit} per {windowMinutes} minutes). Existing reports stay available.
          </p>
        ) : (
          <>
            <p className="text-[11.5px] text-muted">
              <span className="figure text-[13px] text-fg">{remaining}</span>
              <span className="mono text-faint"> / {limit}</span> scans left this {windowMinutes}-minute window
            </p>
            <div className="hidden h-1 w-24 overflow-hidden rounded-full bg-black/40 sm:block" aria-hidden="true">
              <span
                className="block h-full rounded-full bg-gradient-to-r from-teal to-mint"
                style={{ width: `${usedRatio * 100}%` }}
              />
            </div>
            <p className="ml-auto hidden items-center gap-1 text-[11px] text-faint sm:flex">
              Results saved to history <IconArrowRight size={12} />
            </p>
          </>
        )}
      </div>

      {recentTargets.length > 0 && phase !== "running" ? (
        <div>
          <p className="mono mb-2 text-[10px] tracking-[0.12em] text-faint uppercase">Assessed before</p>
          <ul className="flex flex-wrap gap-1.5">
            {recentTargets.map((target) => (
              <li key={target.host}>
                <button
                  type="button"
                  onClick={() => setUrl(target.url)}
                  disabled={quotaExhausted}
                  title={`Last scanned ${target.lastAt}`}
                  className="group inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-panel px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-line-teal hover:text-fg disabled:opacity-50"
                >
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-teal group-hover:bg-mint" />
                  <span className="mono truncate">{target.host}</span>
                  <span className="mono text-[10px] text-faint">×{target.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}
