/**
 * SiteSentra — evidence-based finding analysis.
 *
 * Rules this module obeys (they are the product's integrity rules):
 *  - A finding is only `pass` when we actually observed the thing that makes it pass.
 *  - A missing observation is never treated as secure: it is `fail` (when the
 *    control is expected on the assessed response), `warn`, `inconclusive`
 *    (when the response was not a normal page), or `not_applicable`.
 *  - Every finding carries the raw observed value(s) as evidence.
 *  - Every finding carries an explicit limitation string, because none of these
 *    checks prove a site is secure.
 *
 * This module is pure (no I/O, no relative imports) so it is deterministic and
 * can be executed directly by `node --test`.
 */

// ---------------------------------------------------------------------------
// Shared types (exported from here so the scanner modules stay dependency-free)
// ---------------------------------------------------------------------------

export type HeaderBag = Record<string, string[]>;

export type TlsObservation = {
  protocol: string | null;
  cipher: string | null;
  /** True only when the certificate chain verified against the hostname. */
  authorized: boolean;
  authorizationError: string | null;
  subjectCN: string | null;
  issuerCN: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysUntilExpiry: number | null;
  altNames: string[];
};

export type ObservedHop = {
  url: string;
  hostname: string;
  scheme: "http:" | "https:";
  /** null when no HTTP response was received (transport failure). */
  statusCode: number | null;
  headers: HeaderBag;
  location: string | null;
  tls: TlsObservation | null;
  responseTimeMs: number;
  /** Transport-level failure for this hop, in safe user-facing terms. */
  error: { code: string; message: string } | null;
};

export type Observation = {
  inputUrl: string;
  requestedUrl: string;
  requestedScheme: "http:" | "https:";
  /** Responses for the scheme the user submitted. */
  primaryChain: ObservedHop[];
  /** Responses for the https:// probe of the same origin. */
  httpsChain: ObservedHop[];
  /** Responses for the http:// probe of the same origin (upgrade check). */
  httpChain: ObservedHop[];
  resolvedAddresses: string[];
  pinnedAddress: string | null;
  userAgent: string;
  scannedAt: string;
  totalDurationMs: number;
};

export type FindingStatus =
  | "pass"
  | "fail"
  | "warn"
  | "info"
  | "not_applicable"
  | "inconclusive";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Finding = {
  id: string;
  title: string;
  category: "transport" | "tls" | "headers" | "cookies" | "disclosure";
  status: FindingStatus;
  severity: Severity;
  /** What was checked, in plain language. */
  whatWasChecked: string;
  /** What we actually saw. Never a guess. */
  evidence: Array<{ label: string; value: string }>;
  /** Present when the status is actionable. */
  recommendation: string | null;
  /** What this check cannot tell you. Always present. */
  limitations: string;
};

export type ScanOutcome = "completed" | "inconclusive" | "failed";

export type FindingSummary = {
  total: number;
  pass: number;
  fail: number;
  warn: number;
  info: number;
  not_applicable: number;
  inconclusive: number;
  bySeverity: Record<Severity, number>;
  /** Highest severity among fail/warn findings, or null when there are none. */
  highestActionableSeverity: Severity | null;
};

export type ScanAnalysis = {
  status: ScanOutcome;
  /** URL whose response the header findings were derived from. */
  assessedUrl: string | null;
  findings: Finding[];
  summary: FindingSummary;
  failureCode: string | null;
  failureMessage: string | null;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** OpenSSL/Node error codes that indicate a certificate problem (not a network problem). */
const CERTIFICATE_ERROR_CODES = [
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "NOT_BEFORE_CERT_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_CRL",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "ERR_CERT_AUTHORITY_INVALID",
  "ERR_CERT_COMMON_NAME_INVALID",
  "ERR_CERT_DATE_INVALID",
  "ERR_CERT_VALIDITY_TOO_LONG",
];

export function isCertificateError(code: string): boolean {
  return CERTIFICATE_ERROR_CODES.includes(code);
}

export function headerValues(headers: HeaderBag, name: string): string[] {
  const key = name.toLowerCase();
  return headers[key] ?? [];
}

export function firstHeader(headers: HeaderBag, name: string): string | null {
  return headerValues(headers, name)[0] ?? null;
}

function lastHop(chain: ObservedHop[]): ObservedHop | null {
  const withResponse = chain.filter((hop) => hop.statusCode !== null);
  return withResponse.length > 0 ? withResponse[withResponse.length - 1] : null;
}

function truncate(value: string, max = 600): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function summarise(findings: Finding[]): FindingSummary {
  const summary: FindingSummary = {
    total: findings.length,
    pass: 0,
    fail: 0,
    warn: 0,
    info: 0,
    not_applicable: 0,
    inconclusive: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    highestActionableSeverity: null,
  };
  for (const finding of findings) {
    summary[finding.status] += 1;
    summary.bySeverity[finding.severity] += 1;
    if (finding.status === "fail" || finding.status === "warn") {
      const current = summary.highestActionableSeverity;
      if (current === null || SEVERITY_ORDER.indexOf(finding.severity) < SEVERITY_ORDER.indexOf(current)) {
        summary.highestActionableSeverity = finding.severity;
      }
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Header value parsers (exported for tests)
// ---------------------------------------------------------------------------

export type HstsPolicy = {
  present: boolean;
  maxAge: number | null;
  includeSubDomains: boolean;
  preload: boolean;
  malformed: boolean;
  raw: string | null;
};

export function parseHsts(value: string | null): HstsPolicy {
  if (value === null || value.trim() === "") {
    return { present: false, maxAge: null, includeSubDomains: false, preload: false, malformed: false, raw: value };
  }
  const parts = value.split(";").map((p) => p.trim().toLowerCase());
  let maxAge: number | null = null;
  let malformed = false;
  let sawMaxAge = false;
  for (const part of parts) {
    const match = /^max-age\s*=\s*"?(\d+)"?$/.exec(part);
    if (match) {
      maxAge = Number(match[1]);
      sawMaxAge = true;
      continue;
    }
    if (part === "includesubdomains" || part === "preload") continue;
    if (part === "") continue;
    malformed = true;
  }
  if (!sawMaxAge) malformed = true;
  return {
    present: true,
    maxAge,
    includeSubDomains: parts.includes("includesubdomains"),
    preload: parts.includes("preload"),
    malformed,
    raw: value,
  };
}

export type CspPolicy = {
  present: boolean;
  directives: Record<string, string[]>;
  raw: string | null;
};

export function parseCsp(value: string | null): CspPolicy {
  if (value === null || value.trim() === "") return { present: false, directives: {}, raw: value };
  const directives: Record<string, string[]> = {};
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const [name, ...values] = trimmed.split(/\s+/);
    const key = name.toLowerCase();
    if (!directives[key]) directives[key] = [];
    directives[key].push(...values.map((v) => v.toLowerCase()));
  }
  return { present: true, directives, raw: value };
}

export type ParsedCookie = {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  domain: string | null;
  path: string | null;
  /** True when the cookie has no expiry constraint (session cookie). */
  session: boolean;
};

/**
 * Parse a Set-Cookie header WITHOUT retaining the value.
 * Cookie values are frequently session secrets, so we only keep the name and
 * the security-relevant attributes.
 */
export function parseSetCookie(header: string): ParsedCookie {
  const segments = header.split(";").map((s) => s.trim());
  const [namePart = ""] = segments;
  const eq = namePart.indexOf("=");
  const name = (eq === -1 ? namePart : namePart.slice(0, eq)).trim();
  const attributes = segments.slice(1).map((s) => s.toLowerCase());
  const sameSiteRaw = attributes.find((a) => a.startsWith("samesite"));
  return {
    name: name === "" ? "[empty-name]" : name,
    secure: attributes.includes("secure"),
    httpOnly: attributes.includes("httponly"),
    sameSite: sameSiteRaw ? sameSiteRaw.split("=")[1] ?? null : null,
    domain: attributes.find((a) => a.startsWith("domain="))?.split("=")[1] ?? null,
    path: attributes.find((a) => a.startsWith("path="))?.split("=")[1] ?? null,
    session: !attributes.some((a) => a.startsWith("max-age=") || a.startsWith("expires=")),
  };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

const SCOPE_LIMITATION =
  "SiteSentra only observes a single unauthenticated GET request and its HTTP responses. This is not a penetration test, it cannot detect application-logic flaws, injection, authentication or access-control weaknesses, and a passing result never proves a site is secure.";

function scopeFinding(): Finding {
  return {
    id: "scope-of-assessment",
    title: "What this report does and does not prove",
    category: "disclosure",
    status: "info",
    severity: "info",
    whatWasChecked:
      "No check — this entry documents the boundaries of the assessment so the report cannot be over-interpreted.",
    evidence: [
      { label: "Method", value: "One unauthenticated HTTP(S) GET per origin, following up to 5 redirects" },
      { label: "Data used", value: "TLS handshake metadata, HTTP response headers, Set-Cookie attributes" },
      { label: "Not performed", value: "Payload injection, crawling, authentication, vulnerability scanning, exploitation" },
    ],
    recommendation: null,
    limitations: SCOPE_LIMITATION,
  };
}

function checkHttpsAvailability(obs: Observation): Finding {
  const base = {
    id: "https-availability",
    title: "HTTPS is available on port 443",
    category: "transport" as const,
    whatWasChecked:
      "We attempted a TLS connection to port 443 of the target host and recorded whether a valid HTTPS response was returned.",
  };
  const hop = lastHop(obs.httpsChain);
  const tls = obs.httpsChain.map((h) => h.tls).find((t) => t !== null) ?? null;
  const failedHop = obs.httpsChain.find((h) => h.error !== null) ?? null;

  if (hop && tls) {
    return {
      ...base,
      status: "pass",
      severity: "info",
      evidence: [
        { label: "Final URL", value: hop.url },
        { label: "HTTP status", value: String(hop.statusCode) },
        { label: "TLS protocol", value: tls.protocol ?? "unknown" },
        { label: "Cipher", value: tls.cipher ?? "unknown" },
        { label: "Connected to", value: obs.pinnedAddress ?? "unknown" },
      ],
      recommendation: null,
      limitations:
        "A successful TLS handshake shows that HTTPS is reachable with a certificate our client trusted at scan time. It says nothing about the strength of the rest of the site's configuration or code.",
    };
  }

  if (hop) {
    return {
      ...base,
      status: "pass",
      severity: "info",
      evidence: [
        { label: "Final URL", value: hop.url },
        { label: "HTTP status", value: String(hop.statusCode) },
      ],
      recommendation: null,
      limitations: "HTTPS responded, but no TLS metadata was captured for this hop.",
    };
  }

  const error = failedHop?.error ?? null;
  return {
    ...base,
    status: "fail",
    severity: "high",
    evidence: [
      { label: "Probed", value: `https://${new URL(obs.requestedUrl).hostname}/` },
      { label: "Result", value: error ? `${error.code}: ${error.message}` : "No HTTPS response was received" },
    ],
    recommendation:
      "Serve the site over HTTPS with a certificate from a trusted CA (Let's Encrypt is free). Until then, every request — including credentials and session cookies — can be read or modified on the path between the visitor and the server.",
    limitations:
      "The failure may also be caused by a firewall, geo-blocking, a hostname mismatch or a rate limit that blocks our scanner specifically, so confirm manually with a browser before treating this as definitive.",
  };
}

function checkHttpToHttps(obs: Observation): Finding {
  const base = {
    id: "http-to-https-redirect",
    title: "Plain HTTP requests are redirected to HTTPS",
    category: "transport" as const,
    whatWasChecked:
      "We sent a GET request to http:// on port 80 and recorded whether the server redirected the client to the https:// origin.",
  };
  const first = obs.httpChain[0] ?? null;
  if (!first || first.statusCode === null) {
    return {
      ...base,
      status: "inconclusive",
      severity: "info",
      evidence: [
        { label: "Probed", value: `http://${new URL(obs.requestedUrl).hostname}/` },
        { label: "Result", value: first?.error ? `${first.error.code}: ${first.error.message}` : "No response on port 80" },
      ],
      recommendation: null,
      limitations:
        "Port 80 did not answer, so we cannot tell whether the site upgrades plain HTTP. That may be a deliberate and reasonable choice (no HTTP listener at all) or a temporary network failure.",
    };
  }

  const finalHop = lastHop(obs.httpChain) ?? first;
  const reachedHttps = finalHop.scheme === "https:";
  const location = first.location;
  const isPermanent = first.statusCode === 301 || first.statusCode === 308;
  const pointsToHttps = typeof location === "string" && location.toLowerCase().startsWith("https:");

  if (reachedHttps && (pointsToHttps || isPermanent)) {
    return {
      ...base,
      status: "pass",
      severity: "info",
      evidence: [
        { label: "First response", value: `${first.statusCode} ${first.location ?? "(no Location header)"}` },
        { label: "Redirect chain", value: obs.httpChain.map((h) => `${h.statusCode ?? "ERR"} ${h.url}`).join(" → ") },
        { label: "Final scheme", value: finalHop.scheme },
      ],
      recommendation: isPermanent ? null : "Use a permanent redirect (301 or 308) so browsers and search engines cache the upgrade.",
      limitations:
        "A redirect only protects clients that follow it: the very first HTTP request is still sent in clear text. HSTS is what removes that first-request exposure.",
    };
  }

  if (first.statusCode !== null && first.statusCode >= 200 && first.statusCode < 400 && !reachedHttps) {
    return {
      ...base,
      status: "fail",
      severity: "medium",
      evidence: [
        { label: "First response", value: `${first.statusCode} served over ${first.scheme}` },
        { label: "Location header", value: location ?? "(absent)" },
        { label: "Final URL", value: finalHop.url },
      ],
      recommendation:
        "Return a 301/308 redirect from every http:// request to the equivalent https:// URL, and serve no content over plain HTTP.",
      limitations:
        "We only requested the root path. Some servers redirect per-path or only for HTML requests, so verify the behaviour you care about.",
    };
  }

  return {
    ...base,
    status: "inconclusive",
    severity: "info",
    evidence: [
      { label: "First response", value: `${first.statusCode} ${first.location ?? ""}`.trim() },
      { label: "Redirect chain", value: obs.httpChain.map((h) => `${h.statusCode ?? "ERR"} ${h.url}`).join(" → ") },
    ],
    recommendation: null,
    limitations: "The HTTP response did not clearly resolve to an HTTPS destination, so no conclusion is drawn.",
  };
}

function checkTlsCertificate(obs: Observation, hop: ObservedHop | null): Finding {
  const base = {
    id: "tls-certificate",
    title: "TLS certificate validation",
    category: "tls" as const,
    whatWasChecked:
      "During the TLS handshake we recorded whether the certificate chain was trusted for the requested hostname, plus its subject, issuer and validity window.",
  };
  const tls = hop?.tls ?? null;
  if (!tls) {
    // A rejected handshake still tells us something concrete: the client could
    // not validate the certificate. Report that as evidence, not as a shrug.
    const certFailure = obs.httpsChain.find((h) => h.error !== null && isCertificateError(h.error.code));
    if (certFailure?.error) {
      return {
        ...base,
        status: "fail",
        severity: "critical",
        evidence: [
          { label: "Probed", value: certFailure.url },
          { label: "TLS error code", value: certFailure.error.code },
          { label: "TLS error detail", value: truncate(certFailure.error.message, 300) },
          { label: "Connected to", value: obs.pinnedAddress ?? "unknown" },
        ],
        recommendation:
          "Fix the certificate served for this hostname: it must be issued by a publicly trusted CA, include every hostname visitors use in its subject alternative names, be within its validity period, and include the full chain (leaf + intermediates).",
        limitations:
          "Trust was evaluated with the CA bundle of the machine running the scan. A missing intermediate, a corporate TLS-inspection proxy, or a stale CA bundle can also produce this result — confirm in a normal browser before acting.",
      };
    }
    return {
      ...base,
      status: "inconclusive",
      severity: "info",
      evidence: [{ label: "Result", value: "No TLS handshake was observed for the assessed response" }],
      recommendation: null,
      limitations:
        "Without a handshake we cannot comment on the certificate. This is not evidence that the certificate is bad — or good.",
    };
  }

  const evidence = [
    { label: "Protocol", value: tls.protocol ?? "unknown" },
    { label: "Cipher", value: tls.cipher ?? "unknown" },
    { label: "Subject CN", value: tls.subjectCN ?? "(none)" },
    { label: "Issuer CN", value: tls.issuerCN ?? "(none)" },
    { label: "Valid from", value: tls.validFrom ?? "(unknown)" },
    { label: "Valid to", value: tls.validTo ?? "(unknown)" },
    { label: "Days until expiry", value: tls.daysUntilExpiry === null ? "(unknown)" : String(tls.daysUntilExpiry) },
    { label: "Hostname verified by client", value: tls.authorized ? "yes" : "no" },
    ...(tls.authorizationError ? [{ label: "Client error", value: tls.authorizationError }] : []),
    ...(tls.altNames.length > 0 ? [{ label: "Subject alternative names", value: truncate(tls.altNames.join(", "), 300) }] : []),
  ];

  if (!tls.authorized) {
    return {
      ...base,
      status: "fail",
      severity: "critical",
      evidence,
      recommendation:
        "Install a certificate that is issued by a publicly trusted CA and whose subject alternative names cover the exact hostname visitors use. An untrusted or mismatched certificate means browsers will show a warning and connections can be intercepted.",
      limitations:
        "Trust was evaluated against the CA store of the machine running the scan. Corporate proxies, an expired local CA bundle, or a hostname our client requested differently (for example with/without www) can also produce this result.",
    };
  }

  if (tls.daysUntilExpiry !== null && tls.daysUntilExpiry < 0) {
    return {
      ...base,
      status: "fail",
      severity: "high",
      evidence,
      recommendation: "Renew the certificate — its validity period has already ended.",
      limitations: "Validity dates were read from the certificate presented during our handshake.",
    };
  }

  if (tls.daysUntilExpiry !== null && tls.daysUntilExpiry <= 20) {
    return {
      ...base,
      status: "warn",
      severity: "medium",
      evidence,
      recommendation: `Renew the certificate soon — it expires in ${tls.daysUntilExpiry} day(s).`,
      limitations: "Expiry is a snapshot from the scan time; it will drift as time passes.",
    };
  }

  return {
    ...base,
    status: "pass",
    severity: "info",
    evidence,
    recommendation: null,
    limitations:
      "We verified that the certificate our client received chains to a trusted CA and matches the hostname. We did not test revocation (OCSP/CRL), key size, signature algorithm policy, or whether other certificates are served to different clients.",
  };
}

function checkTlsProtocol(hop: ObservedHop | null): Finding {
  const base = {
    id: "tls-protocol-version",
    title: "Negotiated TLS protocol version",
    category: "tls" as const,
    whatWasChecked: "The TLS protocol version and cipher suite that our client and the server agreed on.",
  };
  const tls = hop?.tls ?? null;
  if (!tls || !tls.protocol) {
    return {
      ...base,
      status: "inconclusive",
      severity: "info",
      evidence: [{ label: "Result", value: "No TLS handshake observed" }],
      recommendation: null,
      limitations: "Nothing was negotiated, so no version can be reported.",
    };
  }

  const version = tls.protocol.toUpperCase();
  const isModern = version.includes("1.3") || version.includes("1.2");
  const evidence = [
    { label: "Negotiated protocol", value: tls.protocol },
    { label: "Cipher suite", value: tls.cipher ?? "unknown" },
  ];

  return {
    ...base,
    status: isModern ? "pass" : "fail",
    severity: isModern ? "info" : "high",
    evidence,
    recommendation: isModern
      ? null
      : "Disable TLS 1.0 and TLS 1.1 on the server or load balancer. Both are deprecated by RFC 8996 and vulnerable to practical downgrade and record-level attacks.",
    limitations:
      "This reports the version negotiated with our client, which by default refuses anything below TLS 1.2. A server that ONLY supports TLS 1.0/1.1 therefore appears as a handshake failure rather than as this finding, and we do not test whether older versions are additionally enabled for other clients.",
  };
}

function checkHsts(hop: ObservedHop | null, overHttps: boolean): Finding {
  const base = {
    id: "strict-transport-security",
    title: "Strict-Transport-Security (HSTS) header",
    category: "headers" as const,
    whatWasChecked:
      "Whether the assessed response includes a Strict-Transport-Security header, and what its max-age and directives are. Browsers only honour HSTS when it is delivered over HTTPS.",
  };
  const raw = hop ? firstHeader(hop.headers, "strict-transport-security") : null;
  const policy = parseHsts(raw);
  const evidence = [
    { label: "Header value", value: policy.raw ? truncate(policy.raw, 300) : "(header not present)" },
    { label: "Delivered over", value: hop ? hop.scheme : "no response" },
    ...(policy.maxAge !== null ? [{ label: "max-age (days)", value: (policy.maxAge / 86400).toFixed(1) }] : []),
  ];

  if (!hop) {
    return {
      ...base,
      status: "inconclusive",
      severity: "info",
      evidence,
      recommendation: null,
      limitations: "No response was assessed, so HSTS could not be evaluated.",
    };
  }

  if (!policy.present) {
    return {
      ...base,
      status: overHttps ? "fail" : "warn",
      severity: overHttps ? "medium" : "low",
      evidence,
      recommendation:
        "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every HTTPS response. Start with a small max-age while you confirm all subdomains work over HTTPS.",
      limitations:
        "Absence on the one response we fetched does not prove the header is missing everywhere; other paths or the load balancer may add it.",
    };
  }

  if (!overHttps) {
    return {
      ...base,
      status: "warn",
      severity: "low",
      evidence,
      recommendation:
        "The header is present but was delivered over plain HTTP, where browsers must ignore it. Make sure the HTTPS response carries it.",
      limitations: "We only saw the HTTP-delivered value; the HTTPS response may already be correct.",
    };
  }

  if (policy.malformed) {
    return {
      ...base,
      status: "warn",
      severity: "low",
      evidence,
      recommendation: "Fix the header syntax — browsers discard a malformed HSTS header entirely.",
      limitations: "Our parser accepts the common forms; an unusual but valid directive could be flagged here.",
    };
  }

  if (policy.maxAge === 0) {
    return {
      ...base,
      status: "warn",
      severity: "medium",
      evidence,
      recommendation: "max-age=0 disables HSTS for browsers that already stored it. Set a real duration if HSTS is intended.",
      limitations: "max-age=0 is also the correct way to deliberately revoke HSTS.",
    };
  }

  if (policy.maxAge === null || policy.maxAge < 15552000) {
    return {
      ...base,
      status: "warn",
      severity: "low",
      evidence,
      recommendation:
        "Use a max-age of at least 15552000 seconds (180 days); 31536000 (1 year) is the value required for preload-list submission.",
      limitations: "A short max-age is sometimes a deliberate rollout choice.",
    };
  }

  return {
    ...base,
    status: "pass",
    severity: "info",
    evidence: [
      ...evidence,
      { label: "includeSubDomains", value: policy.includeSubDomains ? "yes" : "no" },
      { label: "preload", value: policy.preload ? "yes" : "no" },
    ],
    recommendation:
      policy.includeSubDomains
        ? null
        : "Consider adding `includeSubDomains` once every subdomain is confirmed to work over HTTPS.",
    limitations:
      "HSTS protects returning visitors; the first visit is still exposed unless the domain is in the browser preload list.",
  };
}

function checkCsp(hop: ObservedHop | null): Finding {
  const base = {
    id: "content-security-policy",
    title: "Content-Security-Policy header",
    category: "headers" as const,
    whatWasChecked:
      "Whether a Content-Security-Policy header is present on the assessed response, and whether the policy we observed contains directives that weaken it.",
  };
  const raw = hop
    ? (firstHeader(hop.headers, "content-security-policy") ??
      firstHeader(hop.headers, "content-security-policy-report-only"))
    : null;
  const policy = parseCsp(raw);
  const reportOnly = hop ? firstHeader(hop.headers, "content-security-policy") === null && raw !== null : false;
  const evidence = [
    { label: "Header value", value: policy.raw ? truncate(policy.raw) : "(header not present)" },
    ...(reportOnly ? [{ label: "Mode", value: "Content-Security-Policy-Report-Only (not enforced)" }] : []),
    { label: "Directives observed", value: Object.keys(policy.directives).length > 0 ? Object.keys(policy.directives).join(", ") : "(none)" },
  ];

  if (!hop) {
    return { ...base, status: "inconclusive", severity: "info", evidence, recommendation: null, limitations: "No response was assessed." };
  }
  if (!policy.present) {
    return {
      ...base,
      status: "fail",
      severity: "medium",
      evidence,
      recommendation:
        "Add a Content-Security-Policy that restricts where scripts, styles and frames may come from, for example `default-src 'self'; frame-ancestors 'none'; base-uri 'self'`. Introduce it in Report-Only mode first and read the violation reports.",
      limitations:
        "CSP effectiveness depends entirely on the policy's content and on the rest of the application; a present header is not automatically a good one, and we cannot test whether it would actually block an XSS payload.",
    };
  }

  const scriptSources = [...(policy.directives["script-src"] ?? []), ...(policy.directives["default-src"] ?? [])];
  const problems: string[] = [];
  if (scriptSources.includes("'unsafe-inline'")) problems.push("allows 'unsafe-inline' scripts");
  if (scriptSources.includes("'unsafe-eval'")) problems.push("allows 'unsafe-eval'");
  if (scriptSources.includes("*")) problems.push("allows scripts from any origin (*)");
  if (scriptSources.some((s) => s.startsWith("http:"))) problems.push("allows script sources over plain http:");
  const hasScriptControl = Boolean(policy.directives["script-src"] || policy.directives["default-src"]);
  if (!hasScriptControl) problems.push("no script-src or default-src directive");
  const hasFrameControl = Boolean(policy.directives["frame-ancestors"] || policy.directives["default-src"]);

  if (reportOnly) {
    return {
      ...base,
      status: "warn",
      severity: "low",
      evidence,
      recommendation: "The policy is in Report-Only mode, so nothing is enforced in browsers yet. Promote it to an enforced Content-Security-Policy once violations are resolved.",
      limitations: "Report-Only policies are a legitimate rollout step; this is not a vulnerability by itself.",
    };
  }

  if (problems.length > 0) {
    return {
      ...base,
      status: "warn",
      severity: problems.some((p) => p.includes("any origin") || p.includes("unsafe-inline")) ? "medium" : "low",
      evidence: [...evidence, { label: "Weaknesses observed", value: problems.join("; ") }],
      recommendation:
        "Tighten the policy: remove 'unsafe-inline'/'unsafe-eval' from script sources in favour of nonces or hashes, avoid wildcard sources, and add frame-ancestors.",
      limitations:
        "We parsed the policy text only. We did not execute the page, so we cannot tell which directives the site actually relies on.",
    };
  }

  return {
    ...base,
    status: "pass",
    severity: "info",
    evidence: [...evidence, { label: "frame-ancestors controlled", value: hasFrameControl ? "yes" : "no" }],
    recommendation: null,
    limitations:
      "A syntactically reasonable CSP was observed. Its real-world strength depends on the site's markup and on CSP enforcement in browsers, which we did not test.",
  };
}

function checkNosniff(hop: ObservedHop | null): Finding {
  const base = {
    id: "x-content-type-options",
    title: "X-Content-Type-Options: nosniff",
    category: "headers" as const,
    whatWasChecked: "Whether the assessed response sets X-Content-Type-Options to exactly `nosniff`.",
  };
  const raw = hop ? firstHeader(hop.headers, "x-content-type-options") : null;
  const evidence = [{ label: "Header value", value: raw ?? "(header not present)" }];

  if (!hop) return { ...base, status: "inconclusive", severity: "info", evidence, recommendation: null, limitations: "No response was assessed." };
  if (raw === null) {
    return {
      ...base,
      status: "fail",
      severity: "low",
      evidence,
      recommendation: "Add `X-Content-Type-Options: nosniff` to every response. It is one header, has no compatibility cost, and stops browsers MIME-sniffing a response into executing it as script.",
      limitations: "Absence on this response does not prove it is missing site-wide.",
    };
  }
  if (raw.trim().toLowerCase() === "nosniff") {
    return { ...base, status: "pass", severity: "info", evidence, recommendation: null, limitations: "The header was present with the correct value on the assessed response." };
  }
  return {
    ...base,
    status: "warn",
    severity: "low",
    evidence,
    recommendation: "The only valid value is `nosniff`. Any other value is ignored by browsers.",
    limitations: "We compared the value case-insensitively after trimming.",
  };
}

function checkReferrerPolicy(hop: ObservedHop | null): Finding {
  const base = {
    id: "referrer-policy",
    title: "Referrer-Policy header",
    category: "headers" as const,
    whatWasChecked: "Whether the assessed response declares a Referrer-Policy, and whether the chosen policy can leak full URLs to third parties.",
  };
  const raw = hop ? firstHeader(hop.headers, "referrer-policy") : null;
  const evidence = [{ label: "Header value", value: raw ?? "(header not present)" }];

  if (!hop) return { ...base, status: "inconclusive", severity: "info", evidence, recommendation: null, limitations: "No response was assessed." };
  if (raw === null) {
    return {
      ...base,
      status: "fail",
      severity: "low",
      evidence,
      recommendation: "Set `Referrer-Policy: strict-origin-when-cross-origin` (or `no-referrer` if you never need a referrer). Without it, browsers fall back to their own default and full URLs — which often contain tokens or query parameters — may be sent to third parties.",
      limitations: "A page-level `<meta name=\"referrer\">` or per-link `referrerpolicy` attribute can also set this, and we do not parse HTML bodies.",
    };
  }
  const value = raw.trim().toLowerCase();
  const risky = ["unsafe-url", "no-referrer-when-downgrade"];
  if (risky.some((r) => value.includes(r))) {
    return {
      ...base,
      status: "warn",
      severity: "medium",
      evidence,
      recommendation: "Avoid `unsafe-url` and `no-referrer-when-downgrade`: they send full URLs (path and query string) to other origins.",
      limitations: "We only inspected the header value, not how the site links to third parties.",
    };
  }
  return { ...base, status: "pass", severity: "info", evidence, recommendation: null, limitations: "A non-leaky policy value was observed." };
}

function checkClickjacking(hop: ObservedHop | null, csp: CspPolicy): Finding {
  const base = {
    id: "clickjacking",
    title: "Framing protection (X-Frame-Options / CSP frame-ancestors)",
    category: "headers" as const,
    whatWasChecked: "Whether the assessed response restricts who may embed it in a frame, using CSP frame-ancestors and/or X-Frame-Options.",
  };
  const xfo = hop ? firstHeader(hop.headers, "x-frame-options") : null;
  const frameAncestors = csp.directives["frame-ancestors"] ?? [];
  const evidence = [
    { label: "X-Frame-Options", value: xfo ?? "(header not present)" },
    { label: "CSP frame-ancestors", value: frameAncestors.length > 0 ? frameAncestors.join(" ") : "(directive not present)" },
  ];

  if (!hop) return { ...base, status: "inconclusive", severity: "info", evidence, recommendation: null, limitations: "No response was assessed." };

  const hasCspControl = frameAncestors.length > 0;
  const xfoValue = (xfo ?? "").trim().toUpperCase();
  const xfoOk = xfoValue === "DENY" || xfoValue === "SAMEORIGIN" || xfoValue.startsWith("SAMEORIGIN");

  if (hasCspControl && !frameAncestors.includes("*")) {
    return { ...base, status: "pass", severity: "info", evidence, recommendation: null, limitations: "frame-ancestors is the modern, well-supported control; we did not test actual framing behaviour in a browser." };
  }
  if (xfoOk) {
    return {
      ...base,
      status: "pass",
      severity: "info",
      evidence,
      recommendation: hasCspControl ? null : "Consider also declaring `frame-ancestors` in CSP — X-Frame-Options is ignored by modern browsers when CSP frame-ancestors exists, and it cannot express per-origin rules reliably.",
      limitations: "X-Frame-Options is a legacy mechanism; it is not applied consistently in all browsers and does not support ALLOW-FROM.",
    };
  }
  if (xfoValue.startsWith("ALLOW-FROM")) {
    return { ...base, status: "warn", severity: "medium", evidence, recommendation: "Replace the obsolete ALLOW-FROM syntax with CSP `frame-ancestors <origin>`.", limitations: "ALLOW-FROM is ignored by modern browsers, so framing may currently be unrestricted." };
  }
  if (frameAncestors.includes("*")) {
    return { ...base, status: "fail", severity: "medium", evidence, recommendation: "`frame-ancestors *` explicitly allows any site to frame this page. Restrict it to 'none' or your own origins.", limitations: "This may be intentional for an embeddable widget." };
  }
  return {
    ...base,
    status: "fail",
    severity: "medium",
    evidence,
    recommendation: "Send `X-Frame-Options: DENY` and/or `Content-Security-Policy: frame-ancestors 'none'` unless the page is meant to be embeddable.",
    limitations: "Clickjacking risk also depends on whether the page performs state-changing actions without confirmation, which we do not evaluate.",
  };
}

function checkPermissionsPolicy(hop: ObservedHop | null): Finding {
  const base = {
    id: "permissions-policy",
    title: "Permissions-Policy header",
    category: "headers" as const,
    whatWasChecked: "Whether the assessed response limits powerful browser features (camera, microphone, geolocation, payment…) with a Permissions-Policy header.",
  };
  const raw = hop ? (firstHeader(hop.headers, "permissions-policy") ?? firstHeader(hop.headers, "feature-policy")) : null;
  const evidence = [{ label: "Header value", value: raw ? truncate(raw, 300) : "(header not present)" }];
  if (!hop) return { ...base, status: "inconclusive", severity: "info", evidence, recommendation: null, limitations: "No response was assessed." };
  if (raw === null) {
    return {
      ...base,
      status: "warn",
      severity: "low",
      evidence,
      recommendation: "Send a restrictive baseline such as `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` so embedded content and injected scripts cannot silently use device features.",
      limitations: "Many sites legitimately need some of these features; the right policy depends on the application.",
    };
  }
  return { ...base, status: "pass", severity: "info", evidence, recommendation: null, limitations: "We recorded the policy but did not judge whether each allowance is appropriate for this site." };
}

function checkCookies(hop: ObservedHop | null, overHttps: boolean): Finding[] {
  const base = {
    id: "cookie-attributes",
    title: "Cookie security attributes",
    category: "cookies" as const,
    whatWasChecked: "For every Set-Cookie header actually observed on the assessed response, whether the Secure, HttpOnly and SameSite attributes were present.",
  };
  const rawCookies = hop ? headerValues(hop.headers, "set-cookie") : [];

  if (!hop) {
    return [{
      ...base,
      status: "inconclusive",
      severity: "info",
      evidence: [{ label: "Result", value: "No response was assessed" }],
      recommendation: null,
      limitations: "Without a response we cannot know whether the site sets cookies.",
    }];
  }

  if (rawCookies.length === 0) {
    return [{
      ...base,
      status: "not_applicable",
      severity: "info",
      evidence: [
        { label: "Set-Cookie headers observed", value: "0" },
        { label: "Assessed response", value: `${hop.statusCode} ${hop.url}` },
      ],
      recommendation: null,
      limitations:
        "Not applicable — this single unauthenticated request returned no cookies. The site may still set cookies on login, on other paths, or via JavaScript, none of which we observe. This is NOT evidence that the site's cookies are safe.",
    }];
  }

  const parsed = rawCookies.map(parseSetCookie);
  const missingSecure = parsed.filter((c) => !c.secure);
  const missingHttpOnly = parsed.filter((c) => !c.httpOnly);
  const missingSameSite = parsed.filter((c) => c.sameSite === null);
  const weakSameSite = parsed.filter((c) => c.sameSite === "none" && !c.secure);

  const cookieEvidence = parsed.map((c) => ({
    label: `Cookie "${c.name}"`,
    value: [
      c.secure ? "Secure" : "no Secure",
      c.httpOnly ? "HttpOnly" : "no HttpOnly",
      c.sameSite ? `SameSite=${c.sameSite}` : "no SameSite",
      c.domain ? `Domain=${c.domain}` : null,
      c.session ? "session cookie" : null,
    ].filter(Boolean).join(", "),
  }));

  const evidence = [
    { label: "Cookies observed", value: String(parsed.length) },
    ...cookieEvidence,
    { label: "Delivered over", value: hop.scheme },
    { label: "Value stored by SiteSentra", value: "none — cookie values are never persisted" },
  ];

  const problems: string[] = [];
  if (missingSecure.length > 0) problems.push(`${missingSecure.length} cookie(s) without the Secure attribute`);
  if (weakSameSite.length > 0) problems.push(`${weakSameSite.length} cookie(s) with SameSite=None but no Secure attribute (browsers reject these)`);
  if (missingHttpOnly.length > 0) problems.push(`${missingHttpOnly.length} cookie(s) readable by JavaScript (no HttpOnly)`);
  if (missingSameSite.length > 0) problems.push(`${missingSameSite.length} cookie(s) without an explicit SameSite attribute`);

  if (problems.length === 0) {
    return [{
      ...base,
      status: "pass",
      severity: "info",
      evidence,
      recommendation: null,
      limitations: "Only the cookies sent in response to one unauthenticated GET were inspected. Session cookies issued at login are not covered by this scan.",
    }];
  }

  const severity: Severity = !overHttps || missingSecure.length > 0 ? "high" : "medium";
  return [{
    ...base,
    status: "fail",
    severity,
    evidence: [...evidence, { label: "Problems observed", value: problems.join("; ") }],
    recommendation:
      "Set `Secure` on every cookie so it is never transmitted over plain HTTP, `HttpOnly` on any cookie that JavaScript does not need to read, and an explicit `SameSite=Lax` or `Strict` (use `None` only together with `Secure` for genuine cross-site cookies).",
    limitations:
      "We report attributes as sent to our client. A cookie may be re-issued with different flags on other endpoints, and we cannot see cookies set by client-side JavaScript.",
  }];
}

function checkServerDisclosure(hop: ObservedHop | null): Finding {
  const base = {
    id: "server-disclosure",
    title: "Server software disclosure",
    category: "disclosure" as const,
    whatWasChecked: "Whether response headers reveal the server software, framework or version in use.",
  };
  const names = ["server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "x-generator", "x-runtime", "via"];
  const observed = hop
    ? names.map((n) => ({ name: n, value: firstHeader(hop.headers, n) })).filter((e) => e.value !== null)
    : [];
  const evidence = observed.length > 0
    ? observed.map((e) => ({ label: e.name, value: truncate(String(e.value), 200) }))
    : [{ label: "Result", value: "No disclosure headers observed" }];

  if (!hop) return { ...base, status: "inconclusive", severity: "info", evidence, recommendation: null, limitations: "No response was assessed." };

  if (observed.length === 0) {
    return { ...base, status: "pass", severity: "info", evidence, recommendation: null, limitations: "Only the assessed response was inspected; other endpoints may disclose more." };
  }

  const versioned = observed.filter((e) => /\d+\.\d+/.test(String(e.value)));
  return {
    ...base,
    status: versioned.length > 0 ? "warn" : "info",
    severity: "low",
    evidence,
    recommendation: versioned.length > 0
      ? "Remove version numbers from response headers (for example `server_tokens off;` in nginx, or disable X-Powered-By). Version strings make it trivial for an attacker to look up known CVEs for your exact software version."
      : null,
    limitations: "Disclosure is a low-severity hardening item on its own; it does not by itself mean the software is vulnerable, and we did not test any version against a vulnerability database.",
  };
}

function checkCrossOriginPolicies(hop: ObservedHop | null): Finding {
  const base = {
    id: "cross-origin-isolation",
    title: "Cross-origin isolation headers (COOP / CORP / COEP)",
    category: "headers" as const,
    whatWasChecked: "Whether the assessed response sets Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy or Cross-Origin-Embedder-Policy.",
  };
  const coop = hop ? firstHeader(hop.headers, "cross-origin-opener-policy") : null;
  const corp = hop ? firstHeader(hop.headers, "cross-origin-resource-policy") : null;
  const coep = hop ? firstHeader(hop.headers, "cross-origin-embedder-policy") : null;
  const evidence = [
    { label: "Cross-Origin-Opener-Policy", value: coop ?? "(not present)" },
    { label: "Cross-Origin-Resource-Policy", value: corp ?? "(not present)" },
    { label: "Cross-Origin-Embedder-Policy", value: coep ?? "(not present)" },
  ];
  if (!hop) return { ...base, status: "inconclusive", severity: "info", evidence, recommendation: null, limitations: "No response was assessed." };
  if (coop === null && corp === null && coep === null) {
    return {
      ...base,
      status: "info",
      severity: "info",
      evidence,
      recommendation: "Consider `Cross-Origin-Opener-Policy: same-origin` to isolate the browsing context group and limit cross-origin information leakage. COEP/COIP are only needed for shared-memory APIs.",
      limitations: "These headers are optional hardening; their absence is not a vulnerability, and enabling COEP incorrectly can break a site.",
    };
  }
  return { ...base, status: "pass", severity: "info", evidence, recommendation: null, limitations: "We recorded which of the three headers are present without judging whether the chosen values suit this site." };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function analyseObservation(obs: Observation): ScanAnalysis {
  const scope = scopeFinding();

  const primaryHop = lastHop(obs.primaryChain);
  const httpsHop = lastHop(obs.httpsChain);
  const httpHop = lastHop(obs.httpChain);

  // No HTTP response at all → the scan failed. We must not present findings as
  // if the site had been assessed.
  if (!primaryHop && !httpsHop && !httpHop) {
    const anyError =
      [...obs.primaryChain, ...obs.httpsChain, ...obs.httpChain].find((h) => h.error)?.error ?? null;
    // A rejected TLS handshake is still concrete evidence about the target, so
    // surface the certificate finding even though no HTTP response arrived.
    const certFailureSeen = [...obs.httpsChain, ...obs.primaryChain, ...obs.httpChain].some(
      (hopItem) => hopItem.error !== null && isCertificateError(hopItem.error.code),
    );

    const findings: Finding[] = [
      {
        id: "target-reachable",
        title: "The target could not be reached",
        category: "transport",
        status: "fail",
        severity: "info",
        whatWasChecked: "Whether an HTTP(S) response could be obtained from the target at all.",
        evidence: [
          { label: "Requested", value: obs.requestedUrl },
          { label: "Validated addresses connected to", value: obs.resolvedAddresses.length > 0 ? obs.resolvedAddresses.join(", ") : "(none — no socket was opened)" },
          { label: "Requests sent", value: String([...obs.primaryChain, ...obs.httpsChain, ...obs.httpChain].length) },
          { label: "Error", value: anyError ? `${anyError.code}: ${anyError.message}` : "No response received" },
        ],
        recommendation:
          "No security conclusion can be drawn. Check that the host is public and reachable from the internet, that it answers on port 443/80, and that it does not block unknown user agents, then run the scan again.",
        limitations:
          "A failed scan is not a security assessment. Nothing in this report should be read as evidence that the target is secure or insecure.",
      },
      ...(certFailureSeen ? [checkTlsCertificate(obs, null)] : []),
      scope,
    ];
    return {
      status: "failed",
      assessedUrl: null,
      findings,
      summary: summarise(findings),
      failureCode: anyError?.code ?? "unreachable",
      failureMessage: anyError?.message ?? "No HTTP response was received from the target.",
    };
  }

  // Prefer the HTTPS response as the thing we assess, because that is the
  // canonical way the site should be served.
  const assessedHop = httpsHop ?? primaryHop ?? httpHop;
  const overHttps = assessedHop?.scheme === "https:";
  const csp = parseCsp(
    assessedHop ? (firstHeader(assessedHop.headers, "content-security-policy") ?? null) : null,
  );

  const findings: Finding[] = [
    checkHttpsAvailability(obs),
    checkHttpToHttps(obs),
    checkTlsCertificate(obs, overHttps ? assessedHop : httpsHop),
    checkTlsProtocol(overHttps ? assessedHop : httpsHop),
    checkHsts(assessedHop, overHttps === true),
    checkCsp(assessedHop),
    checkNosniff(assessedHop),
    checkReferrerPolicy(assessedHop),
    checkClickjacking(assessedHop, csp),
    checkPermissionsPolicy(assessedHop),
    ...checkCookies(assessedHop, overHttps === true),
    checkServerDisclosure(assessedHop),
    checkCrossOriginPolicies(assessedHop),
    scope,
  ];

  const status: ScanOutcome = assessedHop && assessedHop.statusCode !== null && assessedHop.statusCode >= 400
    ? "inconclusive"
    : "completed";

  if (status === "inconclusive" && assessedHop) {
    findings.unshift({
      id: "assessed-response-status",
      title: "The assessed response was an error page",
      category: "transport",
      status: "inconclusive",
      severity: "info",
      whatWasChecked: "Whether the response we analysed represents the site's normal content.",
      evidence: [
        { label: "Assessed URL", value: assessedHop.url },
        { label: "HTTP status", value: String(assessedHop.statusCode) },
      ],
      recommendation:
        "Re-run the scan against a URL that returns a normal page. Error pages are often served by different infrastructure (a WAF, a CDN or an origin error handler) whose headers do not represent the application.",
      limitations:
        "Findings below describe the error response only. They must not be generalised to the rest of the site.",
    });
  }

  return {
    status,
    assessedUrl: assessedHop?.url ?? null,
    findings,
    summary: summarise(findings),
    failureCode: null,
    failureMessage: null,
  };
}

/** Analysis used when the request was refused before anything was sent. */
export function analyseRejection(input: {
  inputUrl: string;
  code: string;
  message: string;
  scannedAt: string;
}): ScanAnalysis {
  const findings: Finding[] = [
    {
      id: "target-rejected",
      title: "The target was refused by SiteSentra's safety policy",
      category: "transport",
      status: "fail",
      severity: "info",
      whatWasChecked:
        "The URL was validated against SiteSentra's SSRF and abuse policy before any network request was made.",
      evidence: [
        { label: "Submitted URL", value: truncate(input.inputUrl, 300) },
        { label: "Policy code", value: input.code },
        { label: "Reason", value: input.message },
        { label: "Requests sent", value: "0" },
      ],
      recommendation:
        "Submit a public website URL using http:// or https:// on the default port. Internal addresses, IP-literal obfuscations, non-default ports, embedded credentials and non-HTTP schemes are always refused.",
      limitations:
        "No request was made, so this report contains no observations about the target and no security conclusion of any kind.",
    },
    scopeFinding(),
  ];
  return {
    status: "failed",
    assessedUrl: null,
    findings,
    summary: summarise(findings),
    failureCode: input.code,
    failureMessage: input.message,
  };
}
