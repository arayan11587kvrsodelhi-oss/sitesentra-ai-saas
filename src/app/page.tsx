import Link from "next/link";

import { HeroScanForm } from "@/components/hero-scan-form";
import {
  IconArrowRight,
  IconCheck,
  IconClose,
  IconCode,
  IconCookie,
  IconLayers,
  IconLock,
  IconRoute,
  IconShield,
  IconTerminal,
} from "@/components/icons";
import { ScanPreview } from "@/components/marketing/scan-preview";
import { PublicFooter, PublicHeader } from "@/components/site-chrome";
import { CAPABILITIES, HERO_CHECKS, NOT_INCLUDED, SAFETY, WORKFLOW } from "@/components/content";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const CAPABILITY_ICONS: Record<string, typeof IconShield> = {
  headers: IconShield,
  tls: IconLock,
  severity: IconLayers,
  history: IconCode,
  reports: IconCode,
  transcript: IconTerminal,
  cookies: IconCookie,
  limits: IconRoute,
};

/** The six header families, shown as the hero's "surface area" strip. */
const HEADER_FAMILIES = [
  "Strict-Transport-Security",
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Framing protection",
  "Permissions-Policy",
];

export default async function HomePage() {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col bg-base">
      <PublicHeader signedIn={Boolean(user)} />

      <main id="main" className="flex-1">
        {/* ────────────────────────────────────────────────────────────────
            Hero: the argument + entry on the left, the output on the right
            ──────────────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden border-b border-line">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 60% at 15% 0%, rgb(9 136 118 / 0.22) 0%, transparent 60%), radial-gradient(50% 50% at 95% 10%, rgb(17 201 182 / 0.10) 0%, transparent 70%)",
            }}
          />
          <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0 opacity-[0.18] [mask-image:radial-gradient(80%_70%_at_15%_0%,#000,transparent)]" />

          <div className="page relative grid gap-12 py-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:items-center lg:gap-16 lg:py-20">
            <div className="min-w-0">
              <p className="kicker">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
                Website security-header assessment
              </p>

              <h1 className="display mt-6">
                See what your site{" "}
                <span className="relative inline-block text-mint">
                  actually serves.
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 300 12"
                    className="absolute -bottom-1 left-0 w-full text-mint/40"
                    preserveAspectRatio="none"
                  >
                    <path d="M2 9C70 3 210 2 298 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                </span>
              </h1>

              <p className="lede mt-6 max-w-xl">
                One unauthenticated request. A full report on HTTPS, TLS, security headers and cookie flags — with the raw
                observed value, the recommended value and an explicit statement of what each check cannot prove.
              </p>

              <HeroScanForm signedIn={Boolean(user)} />

              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                {[
                  "Evidence on every finding",
                  "No score inflation",
                  "Private to your account",
                ].map((item) => (
                  <span key={item} className="flex items-center gap-2 text-[12px] text-muted">
                    <span className="flex size-4 items-center justify-center rounded-full bg-teal text-mint">
                      <IconCheck size={9} />
                    </span>
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <div className="relative min-w-0">
              <ScanPreview />
              <p className="mt-3 px-1 text-[10.5px] leading-4 text-faint">
                Illustration of a report layout. Live findings come only from a scan you run against a URL you are
                authorised to assess.
              </p>
            </div>
          </div>

          {/* Header families strip */}
          <div className="relative border-t border-line bg-raised/60">
            <div className="page flex flex-wrap items-center gap-x-6 gap-y-2 py-3.5">
              <span className="mono text-[9.5px] tracking-[0.14em] text-faint uppercase">Evaluated</span>
              {HEADER_FAMILIES.map((family) => (
                <span key={family} className="mono flex items-center gap-2 text-[10.5px] text-muted">
                  <span aria-hidden="true" className="size-1 rounded-full bg-mint/60" />
                  {family}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ────────────────────────────────────────────────────────────────
            Workflow — a real numbered sequence
            ──────────────────────────────────────────────────────────────── */}
        <section id="workflow" className="border-b border-line">
          <div className="page py-14 sm:py-20">
            <div className="section-head">
              <div>
                <p className="kicker">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
                  Workflow
                </p>
                <h2 className="h1 mt-4 max-w-xl">From URL to remediation in one bounded pass</h2>
              </div>
              <p className="hidden max-w-xs text-[12px] leading-5 text-muted sm:block">
                Four stages, each one constrained by the same safety policy before a single byte leaves our network.
              </p>
            </div>

            <ol className="relative mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {WORKFLOW.map((item, index) => (
                <li key={item.step} className="group relative rounded-2xl border border-line bg-raised p-5 transition-colors hover:border-line-teal">
                  <div className="flex items-center justify-between">
                    <span className="figure flex size-9 items-center justify-center rounded-full border border-line-teal bg-teal/40 text-[13px] text-mint">
                      {item.step}
                    </span>
                    <span className="mono text-[9.5px] tracking-[0.12em] text-faint uppercase">{item.detail}</span>
                  </div>
                  <h3 className="h3 mt-5">{item.title}</h3>
                  <p className="mt-2 text-[12.5px] leading-6 text-muted">{item.body}</p>
                  {index < WORKFLOW.length - 1 ? (
                    <IconArrowRight
                      size={16}
                      className="absolute top-1/2 -right-5 hidden text-line-strong xl:block"
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ────────────────────────────────────────────────────────────────
            Capabilities — indexed rows, two per line on wide screens
            ──────────────────────────────────────────────────────────────── */}
        <section id="capabilities" className="border-b border-line">
          <div className="page py-14 sm:py-20">
            <div className="grid gap-10 lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-16">
              <div className="lg:sticky lg:top-24 lg:self-start">
                <p className="kicker">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
                  Capabilities
                </p>
                <h2 className="h1 mt-4">What a scan actually produces</h2>
                <p className="mt-4 text-[13px] leading-6 text-muted">
                  Eight observable areas, each with its own evidence trail. Nothing on this list is inferred — if a value
                  was not seen, the finding says so.
                </p>
                <Link href="/methodology" className="btn btn-secondary btn-sm mt-6 gap-1.5">
                  See the full check list
                  <IconArrowRight size={13} />
                </Link>
              </div>

              {/* Borders are drawn per cell rather than with a gap over a
                  coloured parent: the gap trick only paints where two cells
                  meet, which left ragged half-lines at the row edges. */}
              <ul className="grid overflow-hidden rounded-2xl border border-line sm:grid-cols-2">
                {CAPABILITIES.map((cap, index) => {
                  const Icon = CAPABILITY_ICONS[cap.id] ?? IconShield;
                  return (
                    <li
                      key={cap.id}
                      className="cap-cell group relative flex h-full flex-col bg-raised p-5 transition-colors hover:bg-panel"
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex size-8 items-center justify-center rounded-[10px] border border-line-teal bg-teal/50 text-mint transition-colors group-hover:border-mint/40 group-hover:bg-teal">
                          <Icon size={15} />
                        </span>
                        <span className="mono text-[10px] text-faint">{String(index + 1).padStart(2, "0")}</span>
                      </div>
                      <h3 className="h3 mt-4">{cap.title}</h3>
                      <p className="mt-1.5 text-[12px] leading-5 text-muted">{cap.body}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>

        {/* ────────────────────────────────────────────────────────────────
            Trust: what is checked, what is refused, what is never claimed
            ──────────────────────────────────────────────────────────────── */}
        <section id="limits" className="border-b border-line">
          <div className="page grid gap-10 py-14 sm:py-20 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
            <div>
              <p className="kicker">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
                Methodology
              </p>
              <h2 className="h1 mt-4 max-w-xl">An observation engine with hard limits — stated up front</h2>
              <p className="mt-4 max-w-xl text-[13px] leading-6 text-muted">
                Each scan validates the target before a socket opens, resolves DNS once, pins the connection to the
                validated address, and follows at most five redirects — re-checking every hop with the same policy.
              </p>

              <ul className="mt-6 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {HERO_CHECKS.map((item) => (
                  <li key={item} className="flex gap-2.5 text-[12px] leading-5 text-soft">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-teal text-mint">
                      <IconCheck size={9} />
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>

              <Link href="/methodology" className="btn btn-secondary btn-sm mt-7 gap-1.5">
                Read the full methodology
                <IconArrowRight size={13} />
              </Link>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-critical/20 bg-critical/[0.04] p-5">
                <h3 className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
                  <span className="flex size-5 items-center justify-center rounded-full bg-critical/15">
                    <IconClose size={11} className="text-critical" />
                  </span>
                  What SiteSentra does not do
                </h3>
                <ul className="mt-3 space-y-2">
                  {NOT_INCLUDED.map((item) => (
                    <li key={item} className="flex gap-2.5 text-[12px] leading-5 text-muted">
                      <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-[1px] bg-critical/60" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="teal-surface rounded-2xl p-5">
                <h3 className="flex items-center gap-2 text-[12.5px] font-medium text-white">
                  <span className="flex size-5 items-center justify-center rounded-full bg-mint/20">
                    <IconShield size={11} className="text-mint" />
                  </span>
                  Built to be safe to run
                </h3>
                <ul className="mt-3 space-y-2">
                  {SAFETY.map((item) => (
                    <li key={item} className="flex gap-2.5 text-[12px] leading-5 text-white/65">
                      <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-[1px] bg-mint/70" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ────────────────────────────────────────────────────────────────
            Closing CTA
            ──────────────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden">
          <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0 opacity-[0.14]" />
          <div className="page relative py-16 sm:py-20">
            <div className="teal-surface relative overflow-hidden rounded-3xl px-6 py-10 sm:px-12 sm:py-14">
              <div aria-hidden="true" className="pointer-events-none absolute -right-20 -bottom-24 size-80 rounded-full bg-mint/10 blur-3xl" />
              <div className="relative flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
                <div className="max-w-xl">
                  <p className="mono text-[10px] tracking-[0.14em] text-mint/80 uppercase">Start with one URL</p>
                  <h2 className="mt-3 text-[clamp(1.6rem,1.2rem+1.5vw,2.4rem)] leading-tight font-medium tracking-[-0.03em] text-white">
                    Assess a site you are authorised to test.
                  </h2>
                  <p className="mt-3 text-[13px] leading-6 text-white/65">
                    Free account, email and password only. Reports stay private to you until you delete them.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  {user ? (
                    <Link href="/dashboard" className="btn btn-primary btn-lg gap-1.5">
                      Open dashboard
                      <IconArrowRight size={15} />
                    </Link>
                  ) : (
                    <>
                      <Link href="/signup" className="btn btn-primary btn-lg gap-1.5">
                        Create a free account
                        <IconArrowRight size={15} />
                      </Link>
                      <Link href="/login" className="btn btn-lg border-white/15 bg-white/5 text-white hover:bg-white/10">
                        Sign in
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
