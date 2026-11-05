"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout-failed");
    } catch {
      setError("Could not sign out. Please try again.");
    }
    startTransition(() => {
      router.push("/");
      router.refresh();
    });
  }

  return (
    <span className="flex items-center gap-2">
      {error ? (
        <span role="status" className="text-xs text-bad-400">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="rounded-md border border-ink-600 px-3 py-1.5 text-sm text-mist-300 transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-mist-100 disabled:opacity-60"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </span>
  );
}
