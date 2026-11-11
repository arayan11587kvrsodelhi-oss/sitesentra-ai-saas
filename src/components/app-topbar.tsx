"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { IconArrowRight, IconScan } from "@/components/icons";

const SECTIONS: Array<{ href: string; label: string }> = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/history", label: "Scan history" },
  { href: "/methodology", label: "Methodology" },
];

function sectionLabel(pathname: string): string {
  if (pathname.startsWith("/dashboard/scans/")) return "Report";
  const match = SECTIONS.find((item) => item.href !== "/dashboard" && pathname.startsWith(item.href));
  return match?.label ?? "Overview";
}

/**
 * The top bar of the signed-in shell: which section you are in, a quick jump
 * to the scan workspace, and a target search that carries the typed URL into
 * the same scan form the dashboard uses. It never runs a scan itself — the
 * POST contract stays in `/api/scans`.
 */
export function AppTopBar() {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const section = sectionLabel(pathname);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    window.location.assign(`/dashboard?url=${encodeURIComponent(value)}#run-check`);
  }

  const onReport = pathname.startsWith("/dashboard/scans/");

  return (
    <div className="sticky top-[var(--topbar)] z-20 hidden border-b border-line bg-base/80 backdrop-blur-xl lg:top-0 lg:block">
      <div className="flex h-[var(--topbar)] items-center gap-4 px-[var(--gutter)]">
        <nav aria-label="Breadcrumb" className="flex shrink-0 items-center gap-2 text-[12.5px]">
          <span className="text-faint">Workspace</span>
          <span aria-hidden="true" className="text-line-strong">
            /
          </span>
          <span className="font-medium text-fg">{section}</span>
        </nav>

        {onReport ? (
          <Link href="/dashboard/history" className="btn btn-ghost btn-sm gap-1.5 text-[12px]">
            All reports
          </Link>
        ) : null}

        <form onSubmit={onSubmit} className="mx-auto hidden min-w-0 flex-1 max-w-[420px] md:block" role="search">
          <label htmlFor="topbar-search" className="sr-only">
            Find or assess a website
          </label>
          <div
            className={`flex h-9 items-center gap-2 rounded-full border bg-panel px-3 transition-colors ${focused ? "border-mint/70" : "border-line"
              }`}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="shrink-0 text-faint">
              <circle cx="9" cy="9" r="5.2" />
              <path d="m13 13 3.4 3.4" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              id="topbar-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Assess a website, e.g. example.com"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[12px] text-fg placeholder:text-faint focus:outline-none"
            />
            <kbd className="mono hidden rounded border border-line px-1.5 text-[10px] leading-4 text-faint xl:block">/</kbd>
          </div>
        </form>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Link href="/dashboard/history" className="btn btn-ghost btn-sm hidden text-[12px] xl:inline-flex">
            History
          </Link>
          <Link href="/dashboard#run-check" className="btn btn-primary btn-sm gap-1.5">
            <IconScan size={14} />
            New scan
          </Link>
          <Link
            href="/methodology"
            aria-label="Methodology and limits"
            className="flex size-8 items-center justify-center rounded-full border border-line text-faint transition-colors hover:border-line-teal hover:text-mint"
          >
            <IconArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}
