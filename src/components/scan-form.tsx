"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

type Props = {
  remaining: number;
  limit: number;
  windowMinutes: number;
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

export function ScanForm({ remaining, limit, windowMinutes }: Props) {
  const router = useRouter();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const statusId = `${inputId}-status`;

  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const quotaExhausted = remaining <= 0;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
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
      <div className="space-y-2">
        <label htmlFor={inputId} className="block text-sm font-medium text-mist-200">
          Website URL to check
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id={inputId}
            name="url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            placeholder="https://example.com"
            value={url}
            disabled={phase === "running" || quotaExhausted}
            onChange={(event) => setUrl(event.target.value)}
            aria-describedby={`${hintId} ${phase === "error" ? errorId : ""}`.trim()}
            aria-invalid={phase === "error" ? true : undefined}
            className="w-full flex-1 rounded-md border border-ink-600 bg-ink-950 px-3.5 py-2.5 font-mono text-sm text-mist-100 placeholder:font-sans placeholder:text-mist-500 focus:border-signal-400 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={phase === "running" || quotaExhausted}
            className="shrink-0 rounded-md bg-signal-500 px-5 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {phase === "running" ? "Checking…" : "Run check"}
          </button>
        </div>
        <p id={hintId} className="text-sm text-mist-500">
          Public http:// or https:// URLs on the default port only. Internal addresses, IP-literal tricks, non-default
          ports and embedded credentials are refused before any request is sent.
        </p>
        {phase === "error" && message ? (
          <p id={errorId} role="alert" className="text-sm text-bad-400">
            {message}
          </p>
        ) : null}
      </div>

      <div aria-live="polite" aria-atomic="true" id={statusId} className="min-h-[1.5rem] text-sm">
        {phase === "running" ? (
          <p className="flex items-center gap-2 text-signal-300">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 animate-pulse rounded-full bg-signal-400"
            />
            Contacting the target and reading its real responses… {elapsedSeconds}s elapsed. Do not close this tab.
          </p>
        ) : quotaExhausted ? (
          <p className="text-warn-400">
            Scan quota reached ({limit} per {windowMinutes} minutes). Your existing reports stay available below.
          </p>
        ) : (
          <p className="text-mist-500">
            {remaining} of {limit} checks remaining in the current {windowMinutes}-minute window.
          </p>
        )}
      </div>
    </form>
  );
}
