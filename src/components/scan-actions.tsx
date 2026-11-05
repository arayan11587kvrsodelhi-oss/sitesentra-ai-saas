"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Deletes one of the signed-in user's own reports. Server enforces ownership. */
export function DeleteScanButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | "error">("idle");

  async function onDelete() {
    const confirmed = window.confirm(
      "Delete this report permanently? This cannot be undone.",
    );
    if (!confirmed) return;

    setState("working");
    try {
      const response = await fetch(`/api/scans/${reportId}`, { method: "DELETE" });
      if (!response.ok) {
        setState("error");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  return (
    <span className="flex items-center gap-3">
      {state === "error" ? (
        <span role="alert" className="text-xs text-bad-400">
          Could not delete this report.
        </span>
      ) : null}
      <button
        type="button"
        onClick={onDelete}
        disabled={state === "working"}
        className="rounded-md border border-ink-600 px-3 py-1.5 text-sm text-mist-400 transition-colors hover:border-bad-400/50 hover:bg-bad-400/10 hover:text-bad-400 disabled:opacity-60"
      >
        {state === "working" ? "Deleting…" : "Delete report"}
      </button>
    </span>
  );
}
