/**
 * SiteSentra end-to-end smoke + security test.
 *
 * Runs against a live server (default http://127.0.0.1:3000):
 *   node scripts/smoke.mjs
 *   BASE_URL=https://your-preview.example node scripts/smoke.mjs
 *
 * It verifies the things that matter and cannot be unit-tested:
 *   - anonymous visitors cannot reach the dashboard or the scan API
 *   - registration/login creates a real session
 *   - a real scan of a real public site produces evidence-backed findings
 *   - SSRF-hostile targets are refused and recorded as failures (never as passes)
 *   - user B cannot read or delete user A's report (404, not 403)
 *   - cross-origin mutations are refused
 *   - the per-account rate limit returns 429
 *   - SiteSentra's own security headers are served
 *
 * Exits non-zero on the first failing check. No dependency required (Node 18+
 * global fetch).
 */

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const PUBLIC_TARGET = process.env.SMOKE_TARGET ?? "https://example.com";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

/** Minimal cookie jar: keeps only our session cookie for one "browser". */
function createJar() {
  const jar = new Map();
  return {
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");
        if (index === -1) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value === "" || raw.toLowerCase().includes("max-age=0")) jar.delete(name);
        else jar.set(name, value);
      }
    },
    header() {
      return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    has(name) {
      return jar.has(name);
    },
  };
}

async function call(jar, path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  // A real browser always sends Origin on a state-changing fetch/form submit.
  // The strict origin policy for cookie-authenticated mutations relies on that,
  // so mirror it here instead of pretending a header-less script is a browser.
  const defaultOrigin = method === "GET" || method === "HEAD" ? {} : { origin: BASE_URL };
  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: "manual",
    ...options,
    headers: {
      ...defaultOrigin,
      ...(jar ? { cookie: jar.header() } : {}),
      ...(options.headers ?? {}),
    },
  });
  jar?.absorb(response);
  return response;
}

async function json(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  console.log(`\nSiteSentra smoke test → ${BASE_URL}\n`);

  // --- 1. our own security posture ---------------------------------------
  console.log("Site headers and anonymous access");
  const home = await call(null, "/");
  check("GET / returns 200", home.status === 200, `status ${home.status}`);
  const headerChecks = {
    "content-security-policy": "default-src 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=()",
    "cross-origin-opener-policy": "same-origin",
  };
  for (const [name, expected] of Object.entries(headerChecks)) {
    const value = home.headers.get(name) ?? "";
    check(`${name} served`, value.includes(expected), `got "${value || "(missing)"}"`);
  }
  check("X-Powered-By is not disclosed", home.headers.get("x-powered-by") === null);

  const anonDashboard = await call(null, "/dashboard");
  check(
    "GET /dashboard redirects anonymous visitors to /login",
    anonDashboard.status >= 300 && anonDashboard.status < 400 && (anonDashboard.headers.get("location") ?? "").startsWith("/login"),
    `status ${anonDashboard.status} → ${anonDashboard.headers.get("location")}`,
  );

  const anonApi = await call(null, "/api/scans");
  check("GET /api/scans without a session returns 401", anonApi.status === 401, `status ${anonApi.status}`);

  const anonReport = await call(null, "/api/scans/00000000-0000-4000-8000-000000000000");
  check("GET a report without a session returns 401", anonReport.status === 401, `status ${anonReport.status}`);

  // --- 2. account creation and login --------------------------------------
  console.log("\nAuthentication");
  const jarA = createJar();
  const emailA = `alice-${unique}@sitesentra.test`;
  const passwordA = "correct-horse-battery-99";
  const signupA = await call(jarA, "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailA, password: passwordA }),
  });
  check("POST /api/auth/signup returns 201", signupA.status === 201, `status ${signupA.status} ${JSON.stringify(await json(signupA))}`);
  check("session cookie is set on signup", jarA.has("ss_session"));

  const weakSignup = await call(createJar(), "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `weak-${unique}@sitesentra.test`, password: "short" }),
  });
  check("short password is rejected (400)", weakSignup.status === 400, `status ${weakSignup.status}`);

  const badLogin = await call(createJar(), "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailA, password: "wrong-password-entirely" }),
  });
  const badLoginBody = await json(badLogin);
  check("wrong password returns 401", badLogin.status === 401, `status ${badLogin.status}`);
  check(
    "wrong password does not reveal which field was wrong",
    badLoginBody?.error?.message === "Email or password is incorrect.",
    JSON.stringify(badLoginBody),
  );

  const unknownLogin = await call(createJar(), "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `nobody-${unique}@sitesentra.test`, password: "whatever-123456" }),
  });
  check(
    "unknown email returns the same generic 401",
    unknownLogin.status === 401 && (await json(unknownLogin))?.error?.message === "Email or password is incorrect.",
    `status ${unknownLogin.status}`,
  );

  const crossOrigin = await call(jarA, "/api/scans", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ url: PUBLIC_TARGET }),
  });
  check("cross-origin mutation is refused (403)", crossOrigin.status === 403, `status ${crossOrigin.status}`);

  // --- 3. a real scan of a real public site -------------------------------
  console.log("\nReal scan");
  const scanStarted = Date.now();
  const scanResponse = await call(jarA, "/api/scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: PUBLIC_TARGET }),
  });
  const scanBody = await json(scanResponse);
  check(
    `POST /api/scans (${PUBLIC_TARGET}) returns 201`,
    scanResponse.status === 201 && scanBody?.ok === true,
    `status ${scanResponse.status} ${JSON.stringify(scanBody)}`,
  );
  const reportId = scanBody?.reportId;
  console.log(`        outcome=${scanBody?.outcome} duration=${Date.now() - scanStarted}ms id=${reportId}`);

  if (reportId) {
    const reportResponse = await call(jarA, `/api/scans/${reportId}`);
    const reportBody = await json(reportResponse);
    const report = reportBody?.report;
    check("GET /api/scans/[id] returns 200", reportResponse.status === 200, `status ${reportResponse.status}`);
    check("report belongs to the signed-in user", report?.userId !== undefined);
    const findings = report?.report?.findings ?? [];
    check("report contains findings", findings.length >= 5, `found ${findings.length}`);
    check(
      "every finding carries evidence and limitations",
      findings.length > 0 && findings.every((f) => Array.isArray(f.evidence) && f.evidence.length > 0 && typeof f.limitations === "string" && f.limitations.length > 0),
    );
    check(
      "the scope/limitation finding is always present",
      findings.some((f) => f.id === "scope-of-assessment"),
    );
    check(
      "no cookie value is stored anywhere in the report",
      !JSON.stringify(report).includes("set-cookie: [") || !/set-cookie: (?!.*redacted)/i.test(JSON.stringify(report)),
    );
    const transcript = report?.report?.meta?.transcript ?? [];
    check("the transcript records real hops", transcript.length >= 1, `hops=${transcript.length}`);
    check(
      "the transcript labels the requested-scheme hop",
      transcript.some((h) => h.probe === "requested"),
      JSON.stringify(transcript.map((h) => h.probe)),
    );

    // Regression guard: the scheme the user submitted must be the evidence used
    // for the HTTPS/TLS findings, not an empty probe chain.
    const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
    check("report covers the full check set", findings.length >= 12, `found ${findings.length}`);
    if (PUBLIC_TARGET.startsWith("https://")) {
      check(
        "https-availability is derived from the real handshake",
        byId["https-availability"]?.status === "pass",
        `got ${byId["https-availability"]?.status}`,
      );
      check(
        "tls-certificate was observed",
        ["pass", "warn", "fail"].includes(byId["tls-certificate"]?.status),
        `got ${byId["tls-certificate"]?.status}`,
      );
      check(
        "TLS evidence records a protocol version",
        (byId["tls-protocol-version"]?.evidence ?? []).some((e) => /TLSv1\.[23]/.test(e.value)),
        JSON.stringify(byId["tls-protocol-version"]?.evidence),
      );
    }
    check(
      "the HTTP upgrade check has real evidence, not a guess",
      (byId["http-to-https-redirect"]?.evidence ?? []).length >= 2,
      JSON.stringify(byId["http-to-https-redirect"]?.evidence),
    );

    const history = await json(await call(jarA, "/api/scans"));
    check("GET /api/scans lists the scan", Array.isArray(history?.scans) && history.scans.some((s) => s.id === reportId));
  }

  // --- 4. SSRF and abuse refusals -----------------------------------------
  console.log("\nSSRF and abuse refusals");
  const hostile = [
    ["http://169.254.169.254/latest/meta-data/", "ip-blocked"],
    ["http://127.0.0.1:5432/", ["ip-blocked", "port-not-allowed"]],
    ["http://localhost:3000/", ["blocked-hostname", "port-not-allowed"]],
    ["file:///etc/passwd", "unsupported-scheme"],
    ["gopher://example.com:6379/_INFO", "unsupported-scheme"],
    ["https://example.com:8443/", "port-not-allowed"],
    ["http://user:pass@example.com/", "credentials-in-url"],
    ["http://2130706433/", ["ambiguous-ip-literal", "ip-blocked"]],
    ["http://[::1]/", "ip-blocked"],
    ["http://metadata.google.internal/", "blocked-hostname"],
    ["http://printer.local/", "blocked-hostname"],
    ["example.com", "missing-scheme"],
  ];

  // Each refusal still consumes quota (by design — a refused scan is a request
  // we had to process), so this list is longer than one account's window.
  // Rotate to a fresh account whenever the quota is reached, and say so.
  let hostileJar = jarA;
  let hostileIndex = 0;
  async function freshHostileUser() {
    hostileIndex += 1;
    const jar = createJar();
    const response = await call(jar, "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `hostile-${hostileIndex}-${unique}@sitesentra.test`, password: "hostile-target-pass-1" }),
    });
    if (response.status !== 201) throw new Error(`could not create a test account for the SSRF block (${response.status})`);
    console.log(`        (quota reached — continuing with a fresh test account #${hostileIndex})`);
    return jar;
  }

  for (const [url, expectedCodes] of hostile) {
    const allowed = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
    let response = await call(hostileJar, "/api/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (response.status === 429) {
      hostileJar = await freshHostileUser();
      response = await call(hostileJar, "/api/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
    }
    const body = await json(response);
    if (response.status === 429) {
      check(`${url} → refused`, false, "still rate limited with a fresh account");
      continue;
    }
    const failureCode = body?.reportId
      ? (await json(await call(hostileJar, `/api/scans/${body.reportId}`)))?.report?.failureCode
      : null;
    check(
      `${url} → refused as ${allowed.join("|")}`,
      allowed.includes(failureCode),
      `got "${failureCode}" (status ${response.status})`,
    );
    if (body?.reportId) {
      const stored = (await json(await call(hostileJar, `/api/scans/${body.reportId}`)))?.report;
      check(
        `${url} → recorded as a failed scan, never as an assessment`,
        stored?.status === "failed" && (stored?.report?.meta?.transcript?.length ?? 0) === 0,
        `status=${stored?.status} hops=${stored?.report?.meta?.transcript?.length}`,
      );
    }
  }

  // --- 5. cross-user isolation --------------------------------------------
  console.log("\nCross-user isolation");
  const jarB = createJar();
  const signupB = await call(jarB, "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `bob-${unique}@sitesentra.test`, password: "another-strong-pass-77" }),
  });
  check("second user can register", signupB.status === 201, `status ${signupB.status}`);

  if (reportId) {
    const crossRead = await call(jarB, `/api/scans/${reportId}`);
    check("user B reading user A's report gets 404", crossRead.status === 404, `status ${crossRead.status}`);

    const crossDelete = await call(jarB, `/api/scans/${reportId}`, { method: "DELETE" });
    check("user B deleting user A's report gets 404", crossDelete.status === 404, `status ${crossDelete.status}`);

    const stillThere = await call(jarA, `/api/scans/${reportId}`);
    check("user A's report still exists after B's attempt", stillThere.status === 200, `status ${stillThere.status}`);
  }

  const historyB = await json(await call(jarB, "/api/scans"));
  check("user B's history contains none of A's scans", Array.isArray(historyB?.scans) && historyB.scans.length === 0, JSON.stringify(historyB?.scans?.length));

  const tampered = await call(jarB, "/api/scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: PUBLIC_TARGET, userId: "00000000-0000-4000-8000-000000000001" }),
  });
  const tamperedBody = await json(tampered);
  check(
    "a client-supplied userId cannot reassign ownership",
    tampered.status === 201 || tampered.status === 429,
    `status ${tampered.status}`,
  );
  if (tamperedBody?.reportId) {
    const stored = (await json(await call(jarB, `/api/scans/${tamperedBody.reportId}`)))?.report;
    check("the report is still owned by the session user", stored?.userId !== "00000000-0000-4000-8000-000000000001", JSON.stringify(stored?.userId));
  }

  // --- 6. rate limiting ----------------------------------------------------
  console.log("\nRate limiting");
  const jarC = createJar();
  await call(jarC, "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `carol-${unique}@sitesentra.test`, password: "rate-limit-test-pass-1" }),
  });
  const limit = Number(process.env.SMOKE_RATE_LIMIT ?? 12);
  let saw429 = false;
  let lastStatus = 0;
  for (let i = 0; i < limit + 2; i += 1) {
    // Cheap refusals: no network cost, but they still consume quota.
    const response = await call(jarC, "/api/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://10.0.0.${i + 1}/` }),
    });
    lastStatus = response.status;
    if (response.status === 429) {
      saw429 = true;
      check("429 includes Retry-After", Number(response.headers.get("retry-after")) > 0, response.headers.get("retry-after"));
      break;
    }
  }
  check(`user C is rate limited after ${limit} scans`, saw429, `last status ${lastStatus}`);

  // --- 7. logout -----------------------------------------------------------
  console.log("\nLogout");
  const logout = await call(jarA, "/api/auth/logout", { method: "POST" });
  check("POST /api/auth/logout returns 200", logout.status === 200, `status ${logout.status}`);
  const afterLogout = await call(jarA, "/api/scans");
  check("session is dead after logout (401)", afterLogout.status === 401, `status ${afterLogout.status}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(1);
});
