import Link from "next/link";
import type { ReactNode } from "react";

import { Brand } from "@/components/brand";
import { IconCheck, IconLock, IconShield, IconTerminal } from "@/components/icons";

/**
 * Frame for sign-in / sign-up: Liquid Glass.
 *
 * The authentication surface has its own identity, deliberately distinct from
 * the dashboard's flat teal panels: a near-black field with green ambient
 * light, and a frosted card that carries the form. Colours come from the same
 * tokens as the rest of the product (#098876 / #11C9B6), so the two feel like
 * one product without sharing a layout.
 *
 * Layout only — credentials, validation and session handling all live in
 * AuthForm and the API routes and are untouched by this component.
 */
export function AuthShell({
  eyebrow,
  title,
  description,
  side,
  children,
  footer,
  altAction,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  side: { eyebrow: string; heading: string; points: Array<{ icon: "shield" | "lock" | "terminal"; text: string }> };
  children: ReactNode;
  footer: ReactNode;
  altAction: { href: string; label: string; cta: string };
}) {
  const icons = { shield: IconShield, lock: IconLock, terminal: IconTerminal };

  return (
    <div className="liquid-stage relative flex min-h-screen flex-col overflow-hidden">
      {/* Ambient green light — three soft sources, no hard glow on any edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 16% 4%, rgb(9 136 118 / 0.5) 0%, transparent 60%)," +
            "radial-gradient(50% 45% at 92% 18%, rgb(17 201 182 / 0.26) 0%, transparent 64%)," +
            "radial-gradient(65% 55% at 55% 112%, rgb(6 67 61 / 0.75) 0%, transparent 68%)",
        }}
      />
      <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0 opacity-[0.12]" />

      <header className="relative z-10">
        <div className="page flex h-20 items-center justify-between gap-3">
          <Brand />
          <Link
            href={altAction.href}
            className="group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11.5px] text-white/60 backdrop-blur-md transition-colors hover:border-mint/40 hover:text-white sm:gap-2 sm:px-3.5 sm:text-[12px]"
          >
            <span className="hidden sm:inline">{altAction.label}</span>
            <span className="font-medium text-mint">{altAction.cta}</span>
          </Link>
        </div>
      </header>

      <main id="main" className="relative z-10 flex flex-1 items-center">
        <div className="page grid w-full gap-6 py-8 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)] lg:items-stretch lg:gap-8 lg:py-12">
          {/* ---- Glass card: the form ------------------------------------ */}
          <section aria-labelledby="auth-heading" className="glass-card order-1 flex flex-col overflow-hidden lg:order-1">
            <div className="p-6 sm:p-9 lg:p-10">
              <span className="inline-flex items-center gap-2 rounded-full border border-mint/25 bg-mint/10 px-3 py-1 backdrop-blur-md">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-mint shadow-[0_0_8px_rgb(17_201_182/0.9)]" />
                <span className="mono text-[10px] tracking-[0.16em] text-mint uppercase">{eyebrow ?? "Account"}</span>
              </span>

              <h1 id="auth-heading" className="mt-6 text-[clamp(1.75rem,1.4rem+1vw,2.25rem)] leading-[1.08] font-medium tracking-[-0.035em] text-white">
                {title}
              </h1>
              <p className="mt-2.5 max-w-sm text-[13px] leading-6 text-white/55">{description}</p>

              <div className="mt-8">{children}</div>

              <div className="mt-7 flex gap-2.5 border-t border-white/[0.07] pt-5 text-[11px] leading-5 text-white/40">
                <IconShield size={14} className="mt-0.5 shrink-0 text-mint/60" />
                <span>{footer}</span>
              </div>
            </div>
          </section>

          {/* ---- Glass card: context ------------------------------------- */}
          <aside className="glass-card order-2 flex flex-col p-6 sm:p-9 lg:order-2 lg:p-10">
            <div>
              <p className="mono text-[10px] tracking-[0.16em] text-mint/75 uppercase">{side.eyebrow}</p>
              <p className="mt-3 max-w-sm text-[20px] leading-7 font-medium tracking-[-0.025em] text-white">
                {side.heading}
              </p>
              <ul className="mt-7 space-y-4">
                {side.points.map((point) => {
                  const Icon = icons[point.icon];
                  return (
                    <li key={point.text} className="flex gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-mint backdrop-blur-md">
                        <Icon size={14} />
                      </span>
                      <span className="text-[12.5px] leading-6 text-white/60">{point.text}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-auto pt-7">
              <div className="grid grid-cols-3 gap-2 border-t border-white/[0.08] pt-5">
                {[
                  ["1 GET", "per origin"],
                  ["5 hops", "max redirects"],
                  ["0", "scores invented"],
                ].map(([value, label]) => (
                  <div key={label}>
                    <p className="mono text-[13px] text-white">{value}</p>
                    <p className="mt-0.5 text-[10px] leading-4 text-white/40">{label}</p>
                  </div>
                ))}
              </div>
              <p className="mt-5 flex items-center gap-2 text-[10.5px] text-white/35">
                <IconCheck size={11} className="text-mint/60" />
                Configuration observation only — not a penetration test.
              </p>
            </div>
          </aside>
        </div>
      </main>

      <footer className="relative z-10 pb-6">
        <div className="page flex flex-col items-center justify-between gap-1 px-[var(--gutter)] text-[10.5px] text-white/30 sm:flex-row">
          <p>© {new Date().getFullYear()} SiteSentra</p>
          <p className="mono">Only scan sites you own or are authorised to test.</p>
        </div>
      </footer>
    </div>
  );
}
