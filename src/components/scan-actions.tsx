"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { IconTrash } from "@/components/icons";

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
      router.push("/dashboard/history");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  return (
    <span className="flex items-center gap-2">
      {state === "error" ? (
        <span role="alert" className="text-[11.5px] text-critical">
          Could not delete
        </span>
      ) : null}
      <button
        type="button"
        onClick={onDelete}
        disabled={state === "working"}
        className="btn btn-danger btn-sm gap-1.5"
      >
        <IconTrash size={14} />
        {state === "working" ? "Deleting…" : "Delete"}
      </button>
    </span>
  );
}
