"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { AppTopBar } from "@/components/app-topbar";
import { Brand } from "@/components/brand";
import {
  IconChevronDown,
  IconClose,
  IconGauge,
  IconHistory,
  IconMenu,
  IconMethod,
  IconScan,
  IconShield,
  IconSignOut,
} from "@/components/icons";

type NavItem = { href: string; label: string; icon: typeof IconGauge; hint?: string };

const WORKSPACE: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: IconGauge, hint: "Metrics" },
  { href: "/dashboard/history", label: "Scan history", icon: IconHistory, hint: "Reports" },
];

const SECURITY: NavItem[] = [{ href: "/methodology", label: "Methodology", icon: IconMethod, hint: "Limits" }];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function QuotaMeter({ used, limit, windowMinutes }: { used: number; limit: number; windowMinutes: number }) {
  const remaining = Math.max(0, limit - used);
  // The bar shows what is LEFT, matching the "12/12" figure beside it. A bar
  // that filled up as the quota drained would read backwards next to the label.
  const ratio = limit > 0 ? Math.min(1, Math.max(0, remaining / limit)) : 0;
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3.5">
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] tracking-[0.12em] text-white/55 uppercase">Scan quota</span>
        <span className="mono text-[11px] text-white tabular-nums">
          {remaining}
          <span className="text-white/45">/{limit}</span>
        </span>
      </div>
      <div
        className="meter mt-2.5 bg-black/40"
        data-low={remaining > 0 && remaining <= Math.max(1, Math.ceil(limit / 4))}
        data-empty={remaining === 0}
        role="img"
        aria-label={`${remaining} of ${limit} scans remaining in the current ${windowMinutes} minute window`}
      >
        <span style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="mt-2 text-[10.5px] leading-4 text-white/45">Resets on a rolling {windowMinutes}-minute window</p>
    </div>
  );
}

function SignOut() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function signOut() {
    setError(false);
    setPending(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout-failed");
    } catch {
      setError(true);
      setPending(false);
      return;
    }
    // A full document load, not a client-side push: the session is gone, so the
    // whole app (shell, quota, account) must be rendered from scratch. Using
    // router.push here races the RSC fetch against the cookie deletion and can
    // bounce a signed-out user straight back into /login?next=…
    window.location.assign("/");
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[12.5px] text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
      aria-busy={pending}
    >
      <IconSignOut size={15} />
      <span>{pending ? "Signing out…" : error ? "Sign out (retry)" : "Sign out"}</span>
    </button>
  );
}

/**
 * Account section, pinned at the bottom of the deep-teal panel. It is part of
 * the sidebar rather than a floating menu, which keeps identity and the one
 * destructive action (sign out) visible without a click.
 */
function AccountBlock({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  // First letter of the local part that is actually a letter, so a generated
  // address like "1x@…" does not render as a digit next to the status dot.
  const local = email.split("@")[0] ?? "";
  const initial = (local.match(/[a-z]/i)?.[0] ?? local[0] ?? email[0] ?? "?").toUpperCase();

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 p-2.5 text-left"
      >
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-mint text-[13px] font-semibold text-[#02241f]">
          {initial}
          <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-[#06433d] bg-pass" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] leading-4 font-medium text-white" title={email}>
            {email}
          </span>
          <span className="block text-[10.5px] leading-4 text-white/50">Personal workspace</span>
        </span>
        <IconChevronDown
          size={14}
          className={`shrink-0 text-white/50 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="border-t border-white/10 p-1.5">
          <SignOut />
        </div>
      ) : null}
    </div>
  );
}

function NavGroups({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="space-y-6">
      {[
        { title: "Workspace", items: WORKSPACE },
        { title: "Security", items: SECURITY },
      ].map((group) => (
        <div key={group.title}>
          <p className="mono mb-2 px-3 text-[10px] tracking-[0.14em] text-white/40 uppercase">{group.title}</p>
          <ul className="space-y-1">
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className="nav-item"
                  >
                    <Icon size={17} />
                    <span className="truncate">{item.label}</span>
                    {item.hint ? (
                      <span
                        className={`mono ml-auto text-[9.5px] tracking-[0.08em] uppercase ${active ? "text-[#02241f]/60" : "text-white/30"
                          }`}
                      >
                        {item.hint}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Quota + primary call to action, shown between the nav and the account. */
function RailFooter({ quota, onNavigate }: { quota: { used: number; limit: number; windowMinutes: number }; onNavigate: () => void }) {
  return (
    <div className="space-y-3">
      <QuotaMeter {...quota} />
      <Link href="/dashboard#run-check" onClick={onNavigate} className="btn btn-primary w-full">
        <IconScan size={16} />
        New scan
      </Link>
    </div>
  );
}

function ScopeNote() {
  return (
    <p className="flex gap-2 px-1 text-[10.5px] leading-4 text-white/40">
      <IconShield size={13} className="mt-px shrink-0 text-mint/60" />
      Configuration observation only — not a penetration test.
    </p>
  );
}

/**
 * Persistent application frame for signed-in routes.
 *
 * Desktop (>= 1024px): a deep-teal panel with the nav, quota, CTA and account
 * stacked inside it. Content sits to the right, under a sticky top bar that
 * carries the current section and the page's own header.
 * Mobile: a single sticky header with a drawer. The drawer is a real dialog:
 * Escape closes it, focus moves into it, background scroll is locked, and the
 * page never gets a horizontal scrollbar.
 */
export function AppChrome({
  email,
  quota,
  children,
}: {
  email: string;
  quota: { used: number; limit: number; windowMinutes: number };
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  const panel = (
    <div className="teal-surface flex h-full min-h-0 flex-col rounded-none lg:rounded-[26px]">
      <div className="flex h-[var(--topbar)] shrink-0 items-center justify-between px-5">
        <Brand href="/dashboard" onNavigate={close} tone="invert" />
        <button
          ref={closeRef}
          type="button"
          onClick={close}
          className="btn btn-ghost btn-sm px-1.5 text-white/70 lg:hidden"
          aria-label="Close navigation"
        >
          <IconClose size={18} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-between gap-6 overflow-y-auto px-3 pb-4">
        <div className="px-0.5">
          <NavGroups onNavigate={close} />
        </div>
        <RailFooter quota={quota} onNavigate={close} />
      </div>

      <div className="shrink-0 space-y-3 border-t border-white/10 px-3 pt-3 pb-4">
        <AccountBlock email={email} />
        <ScopeNote />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-base">
      {/* Desktop panel */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--rail)] p-3 lg:block">
        <div className="h-full">{panel}</div>
      </aside>

      {/* Mobile header */}
      <div className="sticky top-0 z-30 flex h-[var(--topbar)] items-center justify-between gap-3 border-b border-line bg-base/90 px-4 backdrop-blur-xl lg:hidden">
        <Brand href="/dashboard" />
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard#run-check"
            className="mono rounded-full border border-line-teal bg-teal/40 px-2.5 py-1 text-[10.5px] whitespace-nowrap text-mint"
            title={`${quota.limit - quota.used} of ${quota.limit} scans left in this ${quota.windowMinutes}-minute window`}
          >
            {quota.limit - quota.used}/{quota.limit}
          </Link>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            className="btn btn-secondary btn-sm px-2"
            aria-label="Open navigation"
          >
            <IconMenu size={18} />
          </button>
        </div>
      </div>

      {/* Drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            tabIndex={-1}
          />
          <div
            id="mobile-nav"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="absolute inset-y-0 left-0 flex w-[min(19rem,88vw)] flex-col p-3"
          >
            <span id={titleId} className="sr-only">
              Navigation
            </span>
            <div className="min-h-0 flex-1">{panel}</div>
          </div>
        </div>
      ) : null}

      <div className="lg:pl-[var(--rail)]">
        <AppTopBar />
        <main id="main" className="min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
