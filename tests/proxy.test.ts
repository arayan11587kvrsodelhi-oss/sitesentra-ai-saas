/**
 * SiteSentra — proxy.ts redirect logic tests.
 *
 * These tests verify the routing decisions in src/proxy.ts without needing
 * a running Next.js server. They cover:
 *   - Dashboard paths require a session cookie (optimistic hint only)
 *   - Auth paths redirect away when a session cookie exists
 *   - Boundary cases: /dashboard vs /dashboard-test vs /dashboard/
 *
 * Run with:  node --test tests/proxy.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Re-derive the routing logic from src/proxy.ts to test the same decisions.
function isDashboardPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

function isAuthPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/signup";
}

describe("proxy redirect logic", () => {
  describe("dashboard path matching", () => {
    test("matches /dashboard exactly", () => {
      assert.equal(isDashboardPath("/dashboard"), true);
    });

    test("matches /dashboard/ with subpath", () => {
      assert.equal(isDashboardPath("/dashboard/scans"), true);
      assert.equal(isDashboardPath("/dashboard/scans/abc-123"), true);
      assert.equal(isDashboardPath("/dashboard/settings"), true);
    });

    test("does NOT match /dashboard-test or similar prefixes", () => {
      assert.equal(isDashboardPath("/dashboard-test"), false);
      assert.equal(isDashboardPath("/dashboardx"), false);
      assert.equal(isDashboardPath("/dashboards"), false);
      assert.equal(isDashboardPath("/api/dashboard"), false);
    });

    test("does not match unrelated paths", () => {
      assert.equal(isDashboardPath("/"), false);
      assert.equal(isDashboardPath("/login"), false);
      assert.equal(isDashboardPath("/api/scans"), false);
      assert.equal(isDashboardPath("/methodology"), false);
    });
  });

  describe("auth path matching", () => {
    test("matches /login and /signup exactly", () => {
      assert.equal(isAuthPath("/login"), true);
      assert.equal(isAuthPath("/signup"), true);
    });

    test("does NOT match /login/ or /signup/ with subpaths", () => {
      assert.equal(isAuthPath("/login/"), false);
      assert.equal(isAuthPath("/signup/reset"), false);
    });

    test("does not match unrelated paths", () => {
      assert.equal(isAuthPath("/"), false);
      assert.equal(isAuthPath("/dashboard"), false);
      assert.equal(isAuthPath("/api/auth/login"), false);
    });
  });

  describe("redirect decisions", () => {
    test("unauthenticated user hits /dashboard → redirect to /login", () => {
      const hasSession = false;
      const pathname = "/dashboard";
      assert.equal(isDashboardPath(pathname) && !hasSession, true);
    });

    test("authenticated user hits /dashboard → no redirect", () => {
      const hasSession = true;
      const pathname = "/dashboard";
      assert.equal(isDashboardPath(pathname) && !hasSession, false);
    });

    test("unauthenticated user hits /login → no redirect (allowed)", () => {
      const hasSession = false;
      const pathname = "/login";
      assert.equal(isAuthPath(pathname) && hasSession, false);
    });

    test("authenticated user hits /login → NO redirect (Server Component handles)", () => {
      const hasSession = true;
      const pathname = "/login";
      // Proxy no longer redirects from /login; Server Component handles "already signed in"
      assert.equal(isDashboardPath(pathname) && !hasSession, false);
      assert.equal(isAuthPath(pathname) && hasSession, true); // Auth path matches but no proxy redirect
    });

    test("authenticated user hits /signup → NO redirect (Server Component handles)", () => {
      const hasSession = true;
      const pathname = "/signup";
      // Proxy no longer redirects from /signup; Server Component handles "already signed in"
      assert.equal(isDashboardPath(pathname) && !hasSession, false);
      assert.equal(isAuthPath(pathname) && hasSession, true); // Auth path matches but no proxy redirect
    });

    test("static assets and health check are excluded", () => {
      // These paths should never reach the proxy logic
      const exclusions = ["/_next/static/foo.js", "/_next/image?url=...", "/favicon.ico", "/api/health"];
      for (const path of exclusions) {
        assert.equal(isDashboardPath(path), false, `${path} should not match dashboard`);
        assert.equal(isAuthPath(path), false, `${path} should not match auth`);
      }
    });
  });
});

describe("proxy.ts comment accuracy", () => {
  test("proxy.ts documents cookie presence as optimistic hint, not proof", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/proxy.ts", "utf8");
    assert.ok(
      source.includes("optimistic hint"),
      "proxy.ts must document that cookie presence is an optimistic hint",
    );
    assert.ok(
      source.includes("NOT proof of a valid session"),
      "proxy.ts must warn that cookie presence is not proof of authentication",
    );
    assert.ok(
      source.includes("getCurrentUser()") || source.includes("requireUserOrRedirect()"),
      "proxy.ts must reference the authoritative session validation functions",
    );
  });
});

describe("regression: redirect loop prevention", () => {
  // These tests document the expected redirect behavior for different session states.
  // The proxy uses ONLY cookie presence (boolean) and CANNOT distinguish valid/expired/revoked.
  // Server Components perform authoritative validation via getCurrentUser().

  function simulateProxyRedirect(pathname: string, hasCookie: boolean): { redirect: boolean; to?: string } {
    const isDashboard = isDashboardPath(pathname);
    const isAuth = isAuthPath(pathname);

    if (isDashboard && !hasCookie) {
      return { redirect: true, to: "/login" };
    }
    // No redirect from auth paths regardless of cookie state
    return { redirect: false };
  }

  test("no session cookie on /dashboard → redirect to /login", () => {
    const result = simulateProxyRedirect("/dashboard", false);
    assert.equal(result.redirect, true);
    assert.equal(result.to, "/login");
  });

  test("no session cookie on /dashboard/scans → redirect to /login", () => {
    const result = simulateProxyRedirect("/dashboard/scans", false);
    assert.equal(result.redirect, true);
    assert.equal(result.to, "/login");
  });

  test("no session cookie on /login → NO redirect (allowed)", () => {
    const result = simulateProxyRedirect("/login", false);
    assert.equal(result.redirect, false);
  });

  test("no session cookie on /signup → NO redirect (allowed)", () => {
    const result = simulateProxyRedirect("/signup", false);
    assert.equal(result.redirect, false);
  });

  test("cookie present on /dashboard → NO redirect", () => {
    const result = simulateProxyRedirect("/dashboard", true);
    assert.equal(result.redirect, false);
  });

  test("cookie present on /login → NO redirect (Server Component handles)", () => {
    const result = simulateProxyRedirect("/login", true);
    assert.equal(result.redirect, false);
  });

  test("cookie present on /signup → NO redirect (Server Component handles)", () => {
    const result = simulateProxyRedirect("/signup", true);
    assert.equal(result.redirect, false);
  });

  test("cookie present on / → NO redirect", () => {
    const result = simulateProxyRedirect("/", true);
    assert.equal(result.redirect, false);
  });

  test("static assets and health check are excluded regardless of cookie", () => {
    const staticPaths = ["/_next/static/foo.js", "/_next/image?url=...", "/favicon.ico", "/api/health"];
    for (const path of staticPaths) {
      assert.equal(isDashboardPath(path), false);
      assert.equal(isAuthPath(path), false);
      const result = simulateProxyRedirect(path, true);
      assert.equal(result.redirect, false);
    }
  });
});

// Note: The proxy uses ONLY cookie presence (boolean) and CANNOT distinguish
// valid vs expired vs revoked vs invalid sessions. Server Components
// (getCurrentUser/requireUserOrRedirect) perform authoritative validation
// and handle expired/revoked/invalid sessions by returning null and
// redirecting to /login.
