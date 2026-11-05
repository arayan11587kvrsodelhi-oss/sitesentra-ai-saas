/**
 * Finding-analysis tests.
 *
 * These feed synthetic-but-realistic observations into the analyser and assert
 * that findings are honest: a pass requires an actual observation, a missing
 * header is never reported as secure, and an unreachable target never produces
 * an "assessed" report.
 *
 * Run with:  node --test tests/analyze.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  analyseObservation,
  analyseRejection,
  parseCsp,
  parseHsts,
  parseSetCookie,
  type HeaderBag,
  type Observation,
  type ObservedHop,
} from "../src/lib/scanner/analyze.ts";

function hop(partial: Partial<ObservedHop> & { url: string }): ObservedHop {
  return {
    hostname: new URL(partial.url).hostname,
    scheme: (new URL(partial.url).protocol as "http:" | "https:") ?? "https:",
    statusCode: 200,
    headers: {} as HeaderBag,
    location: null,
    tls: null,
    responseTimeMs: 42,
    error: null,
    ...partial,
  };
}

function observation(partial: Partial<Observation>): Observation {
  return {
    inputUrl: "https://example.com/",
    requestedUrl: "https://example.com/",
    requestedScheme: "https:",
    primaryChain: [],
    httpsChain: [],
    httpChain: [],
    resolvedAddresses: [],
    pinnedAddress: null,
    userAgent: "test",
    scannedAt: new Date().toISOString(),
    totalDurationMs: 10,
    ...partial,
  };
}

const GOOD_TLS = {
  protocol: "TLSv1.3",
  cipher: "TLS_AES_256_GCM_SHA384",
  authorized: true,
  authorizationError: null,
  subjectCN: "example.com",
  issuerCN: "Let's Encrypt",
  validFrom: "2026-01-01T00:00:00Z",
  validTo: "2099-01-01T00:00:00Z",
  daysUntilExpiry: 90,
  altNames: ["example.com", "www.example.com"],
};

function headers(entries: Array<[string, string | string[]]>): HeaderBag {
  const bag: HeaderBag = {};
  for (const [name, value] of entries) bag[name.toLowerCase()] = Array.isArray(value) ? value : [value];
  return bag;
}

function find(findings: ReturnType<typeof analyseObservation>["findings"], id: string) {
  const match = findings.find((f) => f.id === id);
  assert.ok(match, `expected finding "${id}" to exist`);
  return match;
}

describe("header parsers", () => {
  test("parses HSTS directives", () => {
    const policy = parseHsts("max-age=31536000; includeSubDomains; preload");
    assert.equal(policy.present, true);
    assert.equal(policy.maxAge, 31536000);
    assert.equal(policy.includeSubDomains, true);
    assert.equal(policy.preload, true);
    assert.equal(policy.malformed, false);

    assert.equal(parseHsts(null).present, false);
    assert.equal(parseHsts("includeSubDomains").malformed, true, "max-age is mandatory");
    assert.equal(parseHsts('max-age="600"').maxAge, 600);
  });

  test("parses CSP directives", () => {
    const csp = parseCsp("default-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    assert.equal(csp.present, true);
    assert.deepEqual(csp.directives["script-src"], ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(csp.directives["frame-ancestors"], ["'none'"]);
    assert.equal(parseCsp("").present, false);
  });

  test("parses cookie flags without retaining the value", () => {
    const cookie = parseSetCookie("sessionid=SECRET-VALUE-123; Secure; HttpOnly; SameSite=Lax; Path=/");
    assert.equal(cookie.name, "sessionid");
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "lax");
    assert.equal(cookie.path, "/");
    assert.ok(!JSON.stringify(cookie).includes("SECRET-VALUE-123"), "cookie value must never be retained");
  });

  test("handles cookies with no attributes", () => {
    const cookie = parseSetCookie("tracking=abc123");
    assert.equal(cookie.secure, false);
    assert.equal(cookie.httpOnly, false);
    assert.equal(cookie.sameSite, null);
  });
});

describe("a well-configured HTTPS site", () => {
  const httpsHop = hop({
    url: "https://example.com/",
    statusCode: 200,
    tls: GOOD_TLS,
    headers: headers([
      ["strict-transport-security", "max-age=31536000; includeSubDomains"],
      ["content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'self'"],
      ["x-content-type-options", "nosniff"],
      ["referrer-policy", "strict-origin-when-cross-origin"],
      ["x-frame-options", "DENY"],
      ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
    ]),
  });

  const analysis = analyseObservation(
    observation({
      primaryChain: [httpsHop],
      httpsChain: [httpsHop],
      httpChain: [
        hop({ url: "http://example.com/", statusCode: 301, location: "https://example.com/", scheme: "http:" }),
        httpsHop,
      ],
      resolvedAddresses: ["93.184.216.34"],
      pinnedAddress: "93.184.216.34",
    }),
  );

  test("is reported as completed", () => {
    assert.equal(analysis.status, "completed");
    assert.equal(analysis.failureCode, null);
    assert.equal(analysis.assessedUrl, "https://example.com/");
  });

  test("passes the controls that were actually observed", () => {
    assert.equal(find(analysis.findings, "https-availability").status, "pass");
    assert.equal(find(analysis.findings, "http-to-https-redirect").status, "pass");
    assert.equal(find(analysis.findings, "tls-certificate").status, "pass");
    assert.equal(find(analysis.findings, "tls-protocol-version").status, "pass");
    assert.equal(find(analysis.findings, "strict-transport-security").status, "pass");
    assert.equal(find(analysis.findings, "content-security-policy").status, "pass");
    assert.equal(find(analysis.findings, "x-content-type-options").status, "pass");
    assert.equal(find(analysis.findings, "referrer-policy").status, "pass");
    assert.equal(find(analysis.findings, "clickjacking").status, "pass");
    assert.equal(find(analysis.findings, "permissions-policy").status, "pass");
  });

  test("reports cookies as not applicable when none were sent", () => {
    const cookies = find(analysis.findings, "cookie-attributes");
    assert.equal(cookies.status, "not_applicable");
    assert.match(cookies.limitations, /NOT evidence that the site's cookies are safe/);
  });

  test("always includes the scope/limitation finding", () => {
    const scope = find(analysis.findings, "scope-of-assessment");
    assert.equal(scope.status, "info");
    assert.match(scope.limitations, /not a penetration test/i);
  });

  test("carries evidence on every finding", () => {
    for (const finding of analysis.findings) {
      assert.ok(finding.evidence.length > 0, `${finding.id} must have evidence`);
      assert.ok(finding.limitations.length > 0, `${finding.id} must state its limitations`);
    }
  });

  test("summarises counts consistently", () => {
    assert.equal(analysis.summary.total, analysis.findings.length);
    assert.equal(analysis.summary.fail, 0);
    assert.equal(analysis.summary.highestActionableSeverity, null);
  });
});

describe("an insecure HTTP-only site", () => {
  const httpHop = hop({
    url: "http://example.com/",
    scheme: "http:",
    statusCode: 200,
    headers: headers([
      ["server", "Apache/2.4.6 (CentOS)"],
      ["x-powered-by", "PHP/5.4.16"],
      ["set-cookie", ["PHPSESSID=abc123secret; path=/", "remember=xyz; path=/; HttpOnly"]],
    ]),
  });

  const analysis = analyseObservation(
    observation({
      requestedScheme: "http:",
      requestedUrl: "http://example.com/",
      inputUrl: "http://example.com/",
      primaryChain: [httpHop],
      httpsChain: [
        hop({
          url: "https://example.com/",
          statusCode: null,
          error: { code: "ECONNREFUSED", message: "Connection to example.com was refused." },
        }),
      ],
      httpChain: [httpHop],
      resolvedAddresses: ["93.184.216.34"],
      pinnedAddress: "93.184.216.34",
    }),
  );

  test("fails HTTPS availability", () => {
    const finding = find(analysis.findings, "https-availability");
    assert.equal(finding.status, "fail");
    assert.equal(finding.severity, "high");
    assert.ok(finding.recommendation);
  });

  test("fails the HTTP upgrade check", () => {
    assert.equal(find(analysis.findings, "http-to-https-redirect").status, "fail");
  });

  test("fails missing headers instead of assuming they are fine", () => {
    assert.equal(find(analysis.findings, "strict-transport-security").status, "warn");
    assert.equal(find(analysis.findings, "content-security-policy").status, "fail");
    assert.equal(find(analysis.findings, "x-content-type-options").status, "fail");
    assert.equal(find(analysis.findings, "referrer-policy").status, "fail");
    assert.equal(find(analysis.findings, "clickjacking").status, "fail");
  });

  test("reports TLS findings as inconclusive, not passing", () => {
    assert.equal(find(analysis.findings, "tls-certificate").status, "inconclusive");
    assert.equal(find(analysis.findings, "tls-protocol-version").status, "inconclusive");
  });

  test("flags insecure cookies and never stores their values", () => {
    const cookies = find(analysis.findings, "cookie-attributes");
    assert.equal(cookies.status, "fail");
    assert.equal(cookies.severity, "high");
    const serialised = JSON.stringify(cookies);
    assert.ok(!serialised.includes("abc123secret"), "session cookie value must not be stored");
    assert.ok(serialised.includes("PHPSESSID"), "cookie name is evidence and may be stored");
    assert.match(serialised, /no Secure/);
  });

  test("flags version disclosure", () => {
    const disclosure = find(analysis.findings, "server-disclosure");
    assert.equal(disclosure.status, "warn");
    assert.match(JSON.stringify(disclosure.evidence), /Apache\/2\.4\.6/);
  });

  test("records the highest actionable severity", () => {
    assert.equal(analysis.summary.highestActionableSeverity, "high");
  });
});

describe("a certificate failure", () => {
  const analysis = analyseObservation(
    observation({
      httpsChain: [
        hop({
          url: "https://example.com/",
          statusCode: null,
          error: {
            code: "ERR_TLS_CERT_ALTNAME_INVALID",
            message: "Hostname/IP does not match certificate's altnames",
          },
        }),
      ],
      primaryChain: [
        hop({
          url: "https://example.com/",
          statusCode: null,
          error: { code: "ERR_TLS_CERT_ALTNAME_INVALID", message: "Hostname/IP does not match" },
        }),
      ],
    }),
  );

  test("is reported as a critical certificate failure", () => {
    const cert = find(analysis.findings, "tls-certificate");
    assert.equal(cert.status, "fail");
    assert.equal(cert.severity, "critical");
    assert.match(JSON.stringify(cert.evidence), /ERR_TLS_CERT_ALTNAME_INVALID/);
  });

  test("does not claim the scan assessed the site", () => {
    assert.equal(analysis.status, "failed");
  });
});

describe("an error-page response", () => {
  const analysis = analyseObservation(
    observation({
      httpsChain: [hop({ url: "https://example.com/", statusCode: 503, headers: headers([["server", "cloudflare"]]) })],
      primaryChain: [hop({ url: "https://example.com/", statusCode: 503 })],
    }),
  );

  test("is inconclusive and says so explicitly", () => {
    assert.equal(analysis.status, "inconclusive");
    const note = find(analysis.findings, "assessed-response-status");
    assert.equal(note.status, "inconclusive");
    assert.match(note.recommendation ?? "", /Re-run the scan/);
  });
});

describe("an unreachable target", () => {
  const analysis = analyseObservation(
    observation({
      primaryChain: [
        hop({
          url: "https://example.com/",
          statusCode: null,
          error: { code: "ENOTFOUND", message: "Hostname example.com could not be resolved." },
        }),
      ],
    }),
  );

  test("fails without producing any security findings", () => {
    assert.equal(analysis.status, "failed");
    assert.equal(analysis.assessedUrl, null);
    assert.equal(analysis.findings.length, 2, "only the failure notice and the scope notice");
    const failure = find(analysis.findings, "target-reachable");
    assert.equal(failure.status, "fail");
    assert.match(failure.limitations, /not a security assessment/i);
    assert.equal(analysis.failureCode, "ENOTFOUND");
  });
});

describe("a refused target", () => {
  const analysis = analyseRejection({
    inputUrl: "http://169.254.169.254/latest/meta-data/",
    code: "ip-blocked",
    message: "Refusing to connect to 169.254.169.254: link-local / cloud metadata.",
    scannedAt: new Date().toISOString(),
  });

  test("records that zero requests were sent", () => {
    assert.equal(analysis.status, "failed");
    assert.equal(analysis.failureCode, "ip-blocked");
    const refused = find(analysis.findings, "target-rejected");
    assert.match(JSON.stringify(refused.evidence), /"value": "0"|0/);
    assert.match(refused.limitations, /no security conclusion/i);
  });
});

describe("weak but present CSP", () => {
  const analysis = analyseObservation(
    observation({
      httpsChain: [
        hop({
          url: "https://example.com/",
          tls: GOOD_TLS,
          headers: headers([["content-security-policy", "default-src * 'unsafe-inline' 'unsafe-eval'"]]),
        }),
      ],
      primaryChain: [hop({ url: "https://example.com/", tls: GOOD_TLS })],
    }),
  );

  test("is a warning with the weaknesses listed", () => {
    const csp = find(analysis.findings, "content-security-policy");
    assert.equal(csp.status, "warn");
    assert.match(JSON.stringify(csp.evidence), /unsafe-inline/);
  });
});
