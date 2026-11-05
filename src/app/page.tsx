import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/session";
import { SiteFooter, SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

const CHECKS = [
  {
    title: "HTTPS availability & TLS",
    body: "We attempt a real TLS handshake on port 443 and record the negotiated protocol, cipher, certificate subject, issuer, validity window and whether the hostname verified.",
  },
  {
    title: "HTTP → HTTPS upgrade",
    body: "We send a plain HTTP request on port 80 and record whether the server redirects to HTTPS, with which status code, and where the chain finally lands.",
  },
  {
    title: "Security headers",
    body: "Strict-Transport-Security, Content-Security-Policy (parsed for unsafe-inline, unsafe-eval and wildcards), X-Content-Type-Options, Referrer-Policy, framing protection and Permissions-Policy.",
  },
  {
    title: "Cookie attributes",
    body: "Only when cookies are actually observed: Secure, HttpOnly and SameSite flags per cookie. Cookie values are never stored — only names and flags.",
  },
  {
    title: "Disclosure & isolation headers",
    body: "Server/X-Powered-By version disclosure and cross-origin isolation headers (COOP / CORP / COEP), reported as low-severity hardening items.",
  },
  {
    title: "Honest inconclusive results",
    body: "When a response is an error page, a header is missing, or a probe cannot complete, the finding says so explicitly instead of guessing.",
  },
];

const NOT_INCLUDED = [
  "No vulnerability scanning, payload injection or exploitation of any kind.",
  "No crawling, no authenticated testing, no assessment of application logic.",
  "No score that pretends to measure how secure a site is.",
  "No fabricated findings: every statement is backed by an observed value.",
];

export default async function HomePage() {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader user={user ? { email: user.email } : null} />

      <main id="main" className="flex-1">
        <section className="grid-backdrop border-b border-ink-700/70">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <p className="inline-flex items-center gap-2 rounded-full border border-ink-600 bg-ink-900/70 px-3 py-1 text-xs font-medium uppercase tracking-[0.12em] text-signal-300">
              Website Security Intelligence
            </p>
            <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight text-mist-100 sm:text-5xl lg:text-6xl">
              See the security configuration a website{" "}
              <span className="text-signal-400">actually serves</span> — with the evidence.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-mist-300">
              SiteSentra sends one unauthenticated request to a public URL and reports the HTTPS, TLS and HTTP
              security-header configuration it observes. Every finding shows the raw value behind it, a remediation
              step, and an explicit statement of what the check cannot tell you.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href={user ? "/dashboard" : "/signup"}
                className="rounded-md bg-signal-500 px-5 py-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal-400"
              >
                {user ? "Open your dashboard" : "Create a free account"}
              </Link>
              <Link
                href="/methodology"
                className="rounded-md border border-ink-600 bg-ink-900/60 px-5 py-3 text-sm font-semibold text-mist-200 transition-colors hover:border-signal-400/40 hover:text-mist-100"
              >
                Read the methodology &amp; limits
              </Link>
            </div>

            <p className="mt-6 max-w-2xl text-sm text-mist-500">
              Not a penetration test. A passing check means a control was observed on one response — it never proves a
              website is secure.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-mist-100">What the checker observes</h2>
          <p className="mt-2 max-w-2xl text-sm text-mist-400">
            Each item below is a real observation from the target&apos;s HTTP responses, not an inference and not a
            database lookup.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CHECKS.map((check) => (
              <article key={check.title} className="rounded-lg border border-ink-700 bg-ink-900 p-5">
                <h3 className="text-base font-semibold text-mist-100">{check.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-mist-400">{check.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-y border-ink-700/70 bg-ink-900/40">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-mist-100">How a check runs</h2>
              <ol className="mt-6 space-y-5">
                {[
                  {
                    step: "1",
                    title: "You submit a public URL",
                    body: "The URL is validated against an SSRF and abuse policy before any socket is opened.",
                  },
                  {
                    step: "2",
                    title: "We resolve and pin the destination",
                    body: "DNS is resolved once, every returned address is checked against public-range policy, and the connection is pinned to a validated address so it cannot be redirected to internal infrastructure.",
                  },
                  {
                    step: "3",
                    title: "One GET request per origin",
                    body: "HTTPS on 443 and HTTP on 80, following up to five redirects — each hop re-validated with the same rules.",
                  },
                  {
                    step: "4",
                    title: "Findings are written from evidence",
                    body: "The report records what was observed, what it means, how to fix it, and what the check cannot tell you. It is saved to your history.",
                  },
                ].map((item) => (
                  <li key={item.step} className="flex gap-4">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-signal-400/40 bg-signal-400/10 text-xs font-semibold text-signal-300">
                      {item.step}
                    </span>
                    <div>
                      <p className="font-medium text-mist-100">{item.title}</p>
                      <p className="mt-1 text-sm leading-relaxed text-mist-400">{item.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-6">
              <div className="rounded-lg border border-warn-400/25 bg-warn-400/5 p-5">
                <h2 className="text-lg font-semibold text-warn-400">What SiteSentra does not do</h2>
                <ul className="mt-4 space-y-2.5 text-sm text-mist-300">
                  {NOT_INCLUDED.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span aria-hidden="true" className="mt-0.5 text-warn-400">
                        ✕
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-lg border border-ink-700 bg-ink-900 p-5">
                <h2 className="text-lg font-semibold text-mist-100">Built to be safe to run</h2>
                <ul className="mt-4 space-y-2.5 text-sm text-mist-400">
                  <li>Loopback, private, link-local, reserved and cloud-metadata destinations are blocked for IPv4 and IPv6.</li>
                  <li>Redirects are followed manually and re-validated hop by hop.</li>
                  <li>Strict timeouts, a response-size cap and a hard concurrency ceiling.</li>
                  <li>Per-account rate limiting, so the scanner cannot be used to hammer a target.</li>
                </ul>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
