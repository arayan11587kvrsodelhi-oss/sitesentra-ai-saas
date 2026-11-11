import type { Metadata } from "next";
import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/session";
import { PublicFooter, PublicHeader } from "@/components/site-chrome";
import { IconExternal } from "@/components/icons";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Methodology & limitations" };

const SECTIONS = [
  {
    id: "what-a-scan-does",
    heading: "What a scan does",
    items: [
      "Validates the submitted URL against the SSRF and abuse policy before opening any socket.",
      "Resolves the hostname once, classifies every returned IPv4 and IPv6 address, and pins the connection to a validated address.",
      "Sends one unauthenticated GET to the requested origin, plus one probe each to https:// and http:// on the default ports so upgrade behaviour can be assessed.",
      "Follows at most five redirects, re-validating every hop with the identical policy.",
      "Records TLS handshake metadata, response status, response headers and Set-Cookie attribute names.",
      "Derives findings from those observations and stores the report against your account.",
    ],
  },
  {
    id: "ssrf",
    heading: "SSRF and abuse controls",
    items: [
      "Allowed schemes: http and https only. file:, gopher:, dict:, data:, ftp: and similar are rejected.",
      "Allowed ports: 80 and 443 only. Any other explicit port is rejected, which removes port scanning as an attack surface.",
      "Rejected hostnames: loopback, localhost, *.local, *.internal, *.lan, single-label names, and cloud metadata endpoints.",
      "Rejected IP ranges (IPv4): 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, 255.255.255.255.",
      "Rejected IP ranges (IPv6): ::/128, ::1/128, ::/96, 64:ff9b::/96, 100::/64, 2001::/32 (Teredo), 2001:db8::/32, 2002::/16 (6to4), 3fff::/20, 5f00::/8, fc00::/7, fe80::/10, ff00::/8 — including the IPv4 addresses embedded inside transition formats.",
      "Obfuscated IPv4 spellings (2130706433, 0x7f000001, 0177.0.0.1, 127.1) and IPv6 zone identifiers are rejected rather than interpreted.",
      "Credentials in the URL, control characters and whitespace are rejected.",
      "DNS rebinding / TOCTOU: the socket is pinned through a lookup override that returns only the validated address, and the real remote address is re-checked after connect.",
      "Timeouts: bounded per-request inactivity timeout, per-chain deadline and an overall scan budget.",
      "Response bodies are discarded at a byte cap; we never buffer a target's content.",
      "Concurrency: a process-wide semaphore caps simultaneous outbound requests; queued requests fail closed after a bounded wait.",
      "Rate limiting: a durable per-account sliding-window quota plus a one-scan-at-a-time-per-account in-process limit.",
    ],
  },
  {
    id: "authorization",
    heading: "Authorization model",
    items: [
      "Identity always comes from the HttpOnly session cookie resolved against the sessions table on the server.",
      "Report queries filter by the session user's id inside the SQL predicate; a client can never supply a user id.",
      "A report belonging to another user returns the same 404 as one that does not exist, so ids cannot be enumerated.",
      "Row Level Security policies with the same ownership predicates are provided in supabase/schema.sql for deployments that expose tables through the Supabase API.",
    ],
  },
  {
    id: "limitations",
    heading: "Known limitations — read this before trusting a report",
    items: [
      "One unauthenticated GET per origin. Anything behind a login, a WAF challenge, a bot block or geo-restriction is invisible to the scan.",
      "Headers may differ per path, per response status, per user agent or per CDN edge. We report only what our request received.",
      "A missing header is reported as an issue, but absence on one response is not proof it is absent everywhere.",
      "TLS trust is evaluated with the CA bundle of the machine running the scan; our client refuses protocols below TLS 1.2 by default, so a server that only supports TLS 1.0/1.1 appears as a handshake failure rather than a version finding.",
      "We do not test revocation (OCSP/CRL), cipher suite ordering, HSTS preload-list membership, cookie scope beyond attribute names, or client-side JavaScript behaviour.",
      "In-process limits (concurrency) are per server instance; only the database quota is durable across instances.",
      "This is a configuration observation tool. It is not a penetration test and its output is not a security certification.",
    ],
  },
];

const CONTENTS = [
  { href: "#what-a-scan-does", label: "What a scan does" },
  { href: "#ssrf", label: "SSRF and abuse controls" },
  { href: "#authorization", label: "Authorization model" },
  { href: "#limitations", label: "Known limitations" },
  { href: "#acceptable-use", label: "Acceptable use" },
];

export default async function MethodologyPage() {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col bg-base">
      <PublicHeader signedIn={Boolean(user)} />

      <main id="main" className="flex-1">
        <div className="relative overflow-hidden border-b border-line">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(60% 70% at 10% 0%, rgb(9 136 118 / 0.18) 0%, transparent 65%)",
            }}
          />
          <div className="page relative py-10 sm:py-14">
            <span className="kicker">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
              Methodology
            </span>
            <h1 className="h1 mt-5 max-w-3xl text-balance">
              Exactly what SiteSentra checks — and what it cannot tell you
            </h1>
            <p className="lede mt-4 max-w-2xl">
              This page exists so a report is never over-interpreted. Every statement in a SiteSentra report traces back
              to a value observed during the scan described below.
            </p>
          </div>
        </div>

        <div className="page grid gap-10 py-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14 lg:py-14">
          {/* Contents */}
          <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
            <p className="eyebrow mb-3 text-faint">Contents</p>
            <ol className="space-y-1.5 border-l border-line">
              {CONTENTS.map((item, index) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="mono -ml-px flex gap-2 border-l border-transparent py-0.5 pl-3 text-[11.5px] text-muted transition-colors hover:border-mint hover:text-fg"
                  >
                    <span className="text-faint">{String(index + 1).padStart(2, "0")}</span>
                    <span>{item.label}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="min-w-0 space-y-12">
            {SECTIONS.map((section, sIndex) => (
              <section key={section.id} id={section.id} className="scroll-mt-24">
                <div className="flex items-baseline gap-3 border-b border-line pb-3">
                  <span className="mono text-[11px] text-faint">{String(sIndex + 1).padStart(2, "0")}</span>
                  <h2 className="h2 text-[1.125rem]">{section.heading}</h2>
                </div>
                <ul className="mt-4 divide-y divide-line/70">
                  {section.items.map((item) => (
                    <li key={item} className="flex gap-3 py-2.5 text-[12.5px] leading-6 text-soft">
                      <span aria-hidden="true" className="mono mt-2.5 size-1 shrink-0 rounded-[1px] bg-line-strong" />
                      <span className="mono leading-6">{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            <section id="acceptable-use" className="scroll-mt-24 rounded-sm border border-line bg-panel p-5 sm:p-6">
              <h2 className="h2 text-[1.125rem]">Acceptable use</h2>
              <p className="mt-3 max-w-2xl text-[13px] leading-6 text-muted">
                Only submit websites you own or have explicit permission to test. SiteSentra performs a passive
                configuration read — a single unauthenticated GET — and is not an authorisation to test third-party
                systems. Abuse, high-volume scanning or attempts to reach internal infrastructure will result in account
                suspension.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Link href={user ? "/dashboard" : "/signup"} className="btn btn-primary">
                  {user ? "Open the dashboard" : "Create an account"}
                </Link>
                <Link href="/" className="btn btn-ghost gap-1.5">
                  Back to overview
                  <IconExternal size={13} />
                </Link>
              </div>
            </section>
          </div>
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}
