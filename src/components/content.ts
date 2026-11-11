/**
 * Marketing copy. Every claim here is a statement about what the scanner
 * actually does (see src/lib/scanner/*), not a marketing embellishment:
 * no customer counts, no fabricated metrics, no certifications.
 */

export const HERO_CHECKS = [
  "HTTPS availability and the negotiated TLS version, cipher, certificate subject, issuer and expiry",
  "HTTP → HTTPS upgrade behaviour, hop by hop",
  "HSTS, CSP (including unsafe-inline / unsafe-eval / wildcard parsing), X-Content-Type-Options, Referrer-Policy, framing protection and Permissions-Policy",
  "Cookie Secure / HttpOnly / SameSite flags — names and flags only, never values",
  "Server and X-Powered-By version disclosure, and COOP / CORP / COEP isolation headers",
];

export const WORKFLOW = [
  {
    step: "01",
    title: "Submit a public URL",
    body: "The URL is validated against the SSRF policy before any socket is opened. Internal ranges, non-default ports and embedded credentials are refused.",
    detail: "Input",
  },
  {
    step: "02",
    title: "SiteSentra observes the live response",
    body: "DNS is resolved once and the connection pinned to a validated address. One unauthenticated GET per origin, at most five redirects, every hop re-checked.",
    detail: "Observation",
  },
  {
    step: "03",
    title: "Findings are written from evidence",
    body: "Each check records the raw value it saw — or states that it saw nothing. No inference, no guessing, no fabricated result.",
    detail: "Evidence",
  },
  {
    step: "04",
    title: "Review and remediate",
    body: "Findings are grouped by severity with the observed value, the recommended value, and a concrete remediation step. The full request transcript is kept.",
    detail: "Report",
  },
];

export const CAPABILITIES = [
  {
    id: "headers",
    title: "HTTP security-header analysis",
    body: "Six header families evaluated, with CSP parsed for unsafe-inline, unsafe-eval and wildcard sources rather than just checked for presence.",
  },
  {
    id: "tls",
    title: "TLS and transport analysis",
    body: "Real handshake on 443: protocol, cipher, certificate subject, issuer, validity window and whether the hostname verified.",
  },
  {
    id: "severity",
    title: "Severity-based findings",
    body: "Every finding carries a severity and a status — fail, warn, inconclusive, pass — so an unverified check is never mistaken for a passing one.",
  },
  {
    id: "history",
    title: "Scan history",
    body: "Every assessment is stored against your account, newest first, with its severity distribution and a direct link to the full report.",
  },
  {
    id: "reports",
    title: "Detailed reports",
    body: "Observed value, expected value, why it matters and what to change — per finding, all on one page, in the order you need to act.",
  },
  {
    id: "transcript",
    title: "Raw request transcript",
    body: "Every hop with status code, timing, TLS details and the response headers exactly as received. Set-Cookie values are redacted before storage.",
  },
  {
    id: "cookies",
    title: "Cookie attribute review",
    body: "Secure, HttpOnly and SameSite per cookie — only when cookies are actually observed, and only names and flags are kept.",
  },
  {
    id: "limits",
    title: "Explicit limitations",
    body: "Every finding states what the check cannot prove. A clean result never claims that a website is secure.",
  },
];

export const NOT_INCLUDED = [
  "No vulnerability scanning, payload injection or exploitation of any kind.",
  "No crawling, no authenticated testing, no assessment of application logic.",
  "No score that pretends to measure how secure a site is.",
  "No fabricated findings: every statement is backed by an observed value.",
];

export const SAFETY = [
  "Loopback, private, link-local, reserved and cloud-metadata destinations are blocked for IPv4 and IPv6.",
  "Redirects are followed manually and re-validated hop by hop.",
  "Strict timeouts, a response-size cap and a hard concurrency ceiling.",
  "Per-account rate limiting, so the scanner cannot be used to hammer a target.",
];
