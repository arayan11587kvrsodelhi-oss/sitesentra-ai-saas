import type { Metadata } from "next";
import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/session";
import { SiteFooter, SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Methodology & limitations" };

const SECTIONS = [
  {
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
    heading: "Authorization model",
    items: [
      "Identity always comes from the HttpOnly session cookie resolved against the sessions table on the server.",
      "Report queries filter by the session user's id inside the SQL predicate; a client can never supply a user id.",
      "A report belonging to another user returns the same 404 as one that does not exist, so ids cannot be enumerated.",
      "Row Level Security policies with the same ownership predicates are provided in supabase/schema.sql for deployments that expose tables through the Supabase API.",
    ],
  },
  {
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

export default async function MethodologyPage() {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader user={user ? { email: user.email } : null} />
      <main id="main" className="flex-1 border-b border-ink-700/70">
        <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-signal-400">Methodology</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-mist-100 sm:text-4xl">
            Exactly what SiteSentra checks — and what it cannot tell you
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-mist-300">
            This page exists so a report is never over-interpreted. Every statement in a SiteSentra report traces back
            to a value observed during the scan described below.
          </p>

          <div className="mt-10 space-y-10">
            {SECTIONS.map((section) => (
              <section key={section.heading}>
                <h2 className="text-xl font-semibold tracking-tight text-mist-100">{section.heading}</h2>
                <ul className="mt-4 space-y-2.5">
                  {section.items.map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-relaxed text-mist-400">
                      <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-signal-500" />
                      <span className="break-words font-mono text-[0.82rem] sm:text-sm">{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="mt-12 rounded-lg border border-ink-700 bg-ink-900 p-6">
            <h2 className="text-lg font-semibold text-mist-100">Acceptable use</h2>
            <p className="mt-3 text-sm leading-relaxed text-mist-400">
              Only submit websites you own or have explicit permission to test. SiteSentra performs a passive
              configuration read — a single unauthenticated GET — and is not an authorisation to test third-party
              systems. Abuse, high-volume scanning or attempts to reach internal infrastructure will result in account
              suspension.
            </p>
            <div className="mt-5">
              <Link
                href={user ? "/dashboard" : "/signup"}
                className="inline-block rounded-md bg-signal-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal-400"
              >
                {user ? "Go to dashboard" : "Create an account"}
              </Link>
            </div>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
