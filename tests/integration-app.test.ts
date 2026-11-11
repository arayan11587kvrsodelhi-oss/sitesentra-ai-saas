/**
 * SiteSentra — application-level integration tests.
 *
 * Exercises ACTUAL application code paths (route handlers, session helpers)
 * against the isolated integration database. This file is never run directly:
 * `tests/runner.ts` resolves and verifies the database identity first, then
 * points the application's DATABASE_URL at that same database, then imports
 * this file.
 *
 * Run with:
 *   npm run test:integration
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { fixtureEmail, trackUser, trackReport } from "./integration-fixtures.ts";
import { getIntegrationPool } from "./integration-identity.ts";

/**
 * Verified pool provided by `runner.ts` via module registry.
 *
 * It is the SAME pool whose connection was identity-verified before this file
 * was imported, and the same database `src/db/index.ts` was initialised
 * against.
 */
const pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const actual = getIntegrationPool();
    const val = (actual as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? val.bind(actual) : val;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Test-only request context injection. This exercises the same dependency used
// by the route handlers without mutating the `next/headers` ES module namespace.
// ─────────────────────────────────────────────────────────────────────────────

const { runWithSessionRequestContext } = await import("../src/lib/auth/session.ts");

type MockCookieJar = ReturnType<typeof createMockCookieJar>;
type MockState = {
  jar: MockCookieJar["jar"];
  setReader: (getFn: (name: string) => { value: string } | undefined) => void;
};
const mockState = new AsyncLocalStorage<MockState>();

function createMockCookieJar() {
  const values = new Map<string, string>();
  const deleted = new Set<string>();
  let reader: (name: string) => { value: string } | undefined = () => undefined;
  const jar = {
    get(name: string) {
      if (deleted.has(name)) return undefined;
      const value = reader(name) ?? (values.has(name) ? { value: values.get(name)! } : undefined);
      return value;
    },
    set(name: string, value: string) {
      deleted.delete(name);
      values.set(name, value);
    },
    delete(name: string) {
      deleted.add(name);
      values.delete(name);
    },
  };
  return {
    jar,
    setReader(getFn: (name: string) => { value: string } | undefined) {
      reader = getFn;
      values.clear();
      deleted.clear();
    },
  };
}

function installMockCookies(getFn: (name: string) => { value: string } | undefined): MockCookieJar["jar"] {
  const state = mockState.getStore();
  if (!state) return createMockCookieJar().jar;
  state.setReader(getFn);
  return state.jar;
}

function resetMockCookies(): MockCookieJar["jar"] {
  return installMockCookies(() => undefined);
}

function itWithContext(name: string, callback: () => Promise<void>): void {
  it(name, async () => {
    const mock = createMockCookieJar();
    await runWithSessionRequestContext(
      { cookies: mock.jar, headers: new Headers() },
      () => mockState.run({ jar: mock.jar, setReader: mock.setReader }, callback),
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createUser(p: Pool, email: string, password: string): Promise<string> {
  const { hashPassword, newId } = await import("../src/lib/auth/password.ts");
  const hash = await hashPassword(password);
  const result = await p.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
    [newId(), email, hash],
  );
  return trackUser(result.rows[0].id);
}

async function createScanReport(p: Pool, userId: string, url: string, host: string): Promise<string> {
  const result = await p.query(
    `INSERT INTO scan_reports (id, user_id, input_url, target_host, status, report, summary)
     VALUES (gen_random_uuid(), $1, $2, $3, 'completed', '{}', '{}') RETURNING id`,
    [userId, url, host],
  );
  return trackReport(result.rows[0].id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────────────────────

describe("application-level: session flows", () => {
  let userIdA: string;
  let userIdB: string;

  after(() => {
    resetMockCookies();
    // Fixture rows are removed by runner.ts in a finally block, by id.
  });

  itWithContext("createSession() creates DB row", async () => {
    const jar = resetMockCookies();
    userIdA = await createUser(pool, fixtureEmail("session-a"), "testpassword123");

    const { createSession } = await import("../src/lib/auth/session.ts");
    await createSession(userIdA);
    assert.ok(jar.get("ss_session"), "createSession should write the session cookie");

    // Verify session was created in DB
    const result = await pool.query(
      "SELECT id, user_id, revoked_at, expires_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [userIdA],
    );
    assert.equal(result.rows.length, 1, "session should exist in database");
    assert.equal(result.rows[0].user_id, userIdA);
    assert.ok(result.rows[0].revoked_at === null);
    assert.ok(result.rows[0].expires_at > new Date());
  });

  itWithContext("runtime cookie context supports get, set, and delete", async () => {
    const jar = installMockCookies(() => undefined);
    jar.set("ss_session", "runtime-cookie-token");
    assert.deepEqual(jar.get("ss_session"), { value: "runtime-cookie-token" });

    const { destroyCurrentSession, getCurrentUser } = await import("../src/lib/auth/session.ts");
    assert.equal(await getCurrentUser(), null);
    await destroyCurrentSession();
    assert.equal(jar.get("ss_session"), undefined);
    assert.equal(await getCurrentUser(), null);
  });

  itWithContext("concurrent request contexts remain isolated", async () => {
    const { destroyCurrentSession } = await import("../src/lib/auth/session.ts");
    const first = createMockCookieJar();
    const second = createMockCookieJar();
    first.jar.set("ss_session", "first-token");
    second.jar.set("ss_session", "second-token");

    await Promise.all([
      runWithSessionRequestContext(
        { cookies: first.jar, headers: new Headers() },
        async () => {
          await destroyCurrentSession();
          assert.equal(first.jar.get("ss_session"), undefined);
          assert.deepEqual(second.jar.get("ss_session"), { value: "second-token" });
        },
      ),
      runWithSessionRequestContext(
        { cookies: second.jar, headers: new Headers() },
        async () => {
          await destroyCurrentSession();
          assert.equal(second.jar.get("ss_session"), undefined);
          assert.deepEqual(first.jar.get("ss_session"), { value: "first-token" });
        },
      ),
    ]);
  });

  itWithContext("getCurrentUser() returns user for valid cookie", async () => {
    const { createSession } = await import("../src/lib/auth/session.ts");
    await createSession(userIdA);

    // Get token hash from DB
    const { hashToken, generateSessionToken } = await import("../src/lib/auth/password.ts");
    const testToken = generateSessionToken();
    const testTokenHash = hashToken(testToken);

    // Insert session with known token
    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdA, testTokenHash],
    );

    installMockCookies((name: string) => name === "ss_session" ? { value: testToken } : undefined);

    const { getCurrentUser } = await import("../src/lib/auth/session.ts");
    const user = await getCurrentUser();
    assert.ok(user);
    assert.equal(user.id, userIdA);

    // Cleanup test session
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [testTokenHash]);
  });

  itWithContext("getCurrentUser() returns null for forged cookie", async () => {
    installMockCookies(() => ({ value: "forged-token-abc123" }));

    const { getCurrentUser } = await import("../src/lib/auth/session.ts");
    const user = await getCurrentUser();
    assert.equal(user, null);
  });

  itWithContext("getCurrentUser() returns null for missing cookie", async () => {
    installMockCookies(() => undefined);

    const { getCurrentUser } = await import("../src/lib/auth/session.ts");
    const user = await getCurrentUser();
    assert.equal(user, null);
  });

  itWithContext("destroyCurrentSession() revokes DB row", async () => {
    const { createSession } = await import("../src/lib/auth/session.ts");
    await createSession(userIdA);

    // Get token hash from DB
    const { hashToken, generateSessionToken } = await import("../src/lib/auth/password.ts");
    const testToken = generateSessionToken();
    const testTokenHash = hashToken(testToken);

    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdA, testTokenHash],
    );

    installMockCookies((name: string) => name === "ss_session" ? { value: testToken } : undefined);

    const { destroyCurrentSession } = await import("../src/lib/auth/session.ts");
    await destroyCurrentSession();

    // Verify session is revoked
    const result = await pool.query(
      "SELECT revoked_at FROM sessions WHERE token_hash = $1 AND user_id = $2",
      [testTokenHash, userIdA],
    );
    assert.equal(result.rows.length, 1);
    assert.ok(result.rows[0].revoked_at !== null);

    // Cleanup
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [testTokenHash]);
  });

  itWithContext("getCurrentUser() returns null after revocation", async () => {
    const { hashToken, generateSessionToken } = await import("../src/lib/auth/password.ts");
    const revokedToken = generateSessionToken();
    const revokedHash = hashToken(revokedToken);
    const result = await pool.query<{ id: string }>(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days', now()) RETURNING id",
      [userIdA, revokedHash],
    );
    assert.equal(result.rows.length, 1);
    installMockCookies((name: string) => name === "ss_session" ? { value: revokedToken } : undefined);

    const { getCurrentUser } = await import("../src/lib/auth/session.ts");
    const user = await getCurrentUser();
    assert.equal(user, null);
    await pool.query("DELETE FROM sessions WHERE id = $1", [result.rows[0].id]);
  });

  itWithContext("getCurrentUser() returns null for expired session", async () => {
    const { randomBytes, createHash } = await import("node:crypto");
    const { hashToken } = await import("../src/lib/auth/password.ts");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const past = new Date(Date.now() - 86400 * 1000);

    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, $3)",
      [userIdA, tokenHash, past],
    );

    installMockCookies((name: string) => name === "ss_session" ? { value: token } : undefined);

    const { getCurrentUser } = await import("../src/lib/auth/session.ts");
    const user = await getCurrentUser();
    assert.equal(user, null);

    // Cleanup
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  });

  itWithContext("two users have independent sessions", async () => {
    userIdB = await createUser(pool, fixtureEmail("session-b"), "testpassword456");

    const { createSession } = await import("../src/lib/auth/session.ts");
    await createSession(userIdA);
    await createSession(userIdB);

    // Get tokens
    const { hashToken, generateSessionToken } = await import("../src/lib/auth/password.ts");
    const tokenA = generateSessionToken();
    const tokenB = generateSessionToken();
    const hashA = hashToken(tokenA);
    const hashB = hashToken(tokenB);

    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdA, hashA],
    );
    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdB, hashB],
    );

    // As user A
    installMockCookies((name: string) => name === "ss_session" ? { value: tokenA } : undefined);
    const { getCurrentUser } = await import("../src/lib/auth/session.ts");
    const userA = await getCurrentUser();
    assert.ok(userA);
    assert.equal(userA.id, userIdA);

    // As user B
    installMockCookies((name: string) => name === "ss_session" ? { value: tokenB } : undefined);
    const userB = await getCurrentUser();
    assert.ok(userB);
    assert.equal(userB.id, userIdB);
    assert.notEqual(userA.id, userB.id);

    // Cleanup
    await pool.query("DELETE FROM sessions WHERE token_hash IN ($1, $2)", [hashA, hashB]);
  });
});

describe("application-level: logout endpoint", () => {
  let userId: string;

  after(() => {
    resetMockCookies();
  });

  itWithContext("POST /api/auth/logout revokes session and returns ok:true", async () => {
    userId = await createUser(pool, fixtureEmail("logout"), "testpassword123");

    const { createSession } = await import("../src/lib/auth/session.ts");
    await createSession(userId);

    // Get token hash from DB
    const { hashToken, generateSessionToken } = await import("../src/lib/auth/password.ts");
    const testToken = generateSessionToken();
    const testTokenHash = hashToken(testToken);

    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userId, testTokenHash],
    );

    installMockCookies((name: string) => name === "ss_session" ? { value: testToken } : undefined);

    const { POST } = await import("../src/app/api/auth/logout/route.ts");
    const request = new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
    });

    const response = await POST(request);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);

    // Verify session is revoked
    const result = await pool.query(
      "SELECT revoked_at FROM sessions WHERE token_hash = $1",
      [testTokenHash],
    );
    assert.equal(result.rows.length, 1);
    assert.ok(result.rows[0].revoked_at !== null);

    // Cleanup
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [testTokenHash]);
  });

  itWithContext("POST /api/auth/logout rejects cross-origin", async () => {
    const { POST } = await import("../src/app/api/auth/logout/route.ts");
    const request = new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { origin: "http://evil.com", "content-type": "application/json" },
    });
    const response = await POST(request);
    assert.equal(response.status, 403);
  });
});

describe("application-level: remaining route handlers", () => {
  itWithContext("GET /api/health can be invoked directly", async () => {
    const { GET } = await import("../src/app/api/health/route.ts");
    const response = await GET();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.ok, "boolean");
  });

  itWithContext("POST /api/scans can be invoked directly and rejects an anonymous caller", async () => {
    resetMockCookies();
    const { POST } = await import("../src/app/api/scans/route.ts");
    const response = await POST(
      new Request("http://localhost/api/scans", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    );
    assert.equal(response.status, 401);
  });
});

describe("application-level: scan ownership", () => {
  let userIdA: string;
  let userIdB: string;
  let tokenA: string;
  let tokenB: string;
  let reportIdA: string;
  let reportIdB: string;

  after(() => {
    resetMockCookies();
  });

  itWithContext("GET /api/scans returns only current user's reports", async () => {
    userIdA = await createUser(pool, fixtureEmail("scan-a"), "testpassword123");
    userIdB = await createUser(pool, fixtureEmail("scan-b"), "testpassword456");

    const { createSession } = await import("../src/lib/auth/session.ts");
    await createSession(userIdA);
    await createSession(userIdB);

    // Get tokens
    const { hashToken, generateSessionToken } = await import("../src/lib/auth/password.ts");
    tokenA = generateSessionToken();
    tokenB = generateSessionToken();

    const hashA = hashToken(tokenA);
    const hashB = hashToken(tokenB);

    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdA, hashA],
    );
    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdB, hashB],
    );

    reportIdA = await createScanReport(pool, userIdA, "https://alice.example.com/", "alice.example.com");
    reportIdB = await createScanReport(pool, userIdB, "https://bob.example.com/", "bob.example.com");

    // As user A
    installMockCookies((name: string) => name === "ss_session" ? { value: tokenA } : undefined);

    const { GET } = await import("../src/app/api/scans/route.ts");
    const response = await GET();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.scans.length, 1);
    assert.equal(body.scans[0].id, reportIdA);

    // Cleanup session tokens
    await pool.query("DELETE FROM sessions WHERE token_hash IN ($1, $2)", [hashA, hashB]);
  });

  itWithContext("GET /api/scans/[id] returns report for owner, 404 for non-owner", async () => {
    const { hashToken, generateSessionToken } = await import("../src/lib/auth/password.ts");

    // Create tokens for owner and non-owner
    const ownerToken = generateSessionToken();
    const nonOwnerToken = generateSessionToken();
    const ownerHash = hashToken(ownerToken);
    const nonOwnerHash = hashToken(nonOwnerToken);

    // Insert sessions
    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdA, ownerHash],
    );
    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdB, nonOwnerHash],
    );

    const { GET } = await import("../src/app/api/scans/[id]/route.ts");

    // Owner access
    installMockCookies((name: string) => name === "ss_session" ? { value: ownerToken } : undefined);
    const responseA = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: reportIdA }) });
    assert.equal(responseA.status, 200, "owner should get 200");

    // Non-owner access
    installMockCookies((name: string) => name === "ss_session" ? { value: nonOwnerToken } : undefined);
    const responseB = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: reportIdA }) });
    assert.equal(responseB.status, 404, "non-owner should get 404");

    // Cleanup
    await pool.query("DELETE FROM sessions WHERE token_hash IN ($1, $2)", [ownerHash, nonOwnerHash]);
  });

  itWithContext("DELETE /api/scans/[id] removes only owner's report", async () => {
    const { hashToken, generateSessionToken } = await import("../src/lib/auth/password.ts");
    const nonOwnerToken = generateSessionToken();
    const nonOwnerHash = hashToken(nonOwnerToken);

    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() + interval '7 days')",
      [userIdB, nonOwnerHash],
    );

    const { DELETE } = await import("../src/app/api/scans/[id]/route.ts");

    // Non-owner tries to delete
    installMockCookies((name: string) => name === "ss_session" ? { value: nonOwnerToken } : undefined);
    const request = new Request("http://localhost/api/scans/test", {
      method: "DELETE",
      headers: { origin: "http://localhost" },
    });
    const response = await DELETE(request, { params: Promise.resolve({ id: reportIdA }) });
    assert.equal(response.status, 404);

    // Verify report still exists
    const check = await pool.query("SELECT id FROM scan_reports WHERE id = $1", [reportIdA]);
    assert.equal(check.rows.length, 1, "report should still exist");

    // Cleanup
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [nonOwnerHash]);
  });
});

describe("application-level: auth endpoints", () => {
  after(() => {
    resetMockCookies();
  });

  itWithContext("POST /api/auth/signup creates user and session", async () => {
    const { POST } = await import("../src/app/api/auth/signup/route.ts");
    const email = fixtureEmail("signup");

    resetMockCookies();

    const body = JSON.stringify({ email, password: "testpassword123" });
    const request = new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() },
      body,
    });

    const response = await POST(request);
    assert.equal(response.status, 201);
    const json = await response.json();
    trackUser(json.user.id);
    assert.equal(json.ok, true);
    assert.ok(json.user.id);
    assert.ok(json.next);
  });

  itWithContext("POST /api/auth/signup rejects duplicate email", async () => {
    const { POST } = await import("../src/app/api/auth/signup/route.ts");
    const email = fixtureEmail("duplicate");

    resetMockCookies();

    // First signup
    const body1 = JSON.stringify({ email, password: "testpassword123" });
    const request1 = new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body1).toString() },
      body: body1,
    });
    const result1 = await POST(request1);
    const json1 = await result1.json();
    trackUser(json1.user.id);

    // Second signup with same email
    resetMockCookies();
    const body2 = JSON.stringify({ email, password: "testpassword456" });
    const request2 = new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body2).toString() },
      body: body2,
    });
    const response = await POST(request2);
    assert.equal(response.status, 409);
  });

  itWithContext("POST /api/auth/login authenticates and creates session", async () => {
    const email = fixtureEmail("login");
    const { hashPassword } = await import("../src/lib/auth/password.ts");
    const result = await pool.query(
      "INSERT INTO users (id, email, password_hash) VALUES (gen_random_uuid(), $1, $2) RETURNING id",
      [email, await hashPassword("testpassword123")],
    );
    trackUser(result.rows[0].id);

    const { POST } = await import("../src/app/api/auth/login/route.ts");
    resetMockCookies();

    const body = JSON.stringify({ email, password: "testpassword123" });
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() },
      body,
    });

    const response = await POST(request);
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.ok, true);
    assert.equal(json.user.id, result.rows[0].id);
  });

  itWithContext("POST /api/auth/login rejects invalid password", async () => {
    const email = fixtureEmail("login-failure");
    const { hashPassword } = await import("../src/lib/auth/password.ts");
    const result = await pool.query(
      "INSERT INTO users (id, email, password_hash) VALUES (gen_random_uuid(), $1, $2) RETURNING id",
      [email, await hashPassword("correctpassword")],
    );
    trackUser(result.rows[0].id);

    const { POST } = await import("../src/app/api/auth/login/route.ts");
    resetMockCookies();

    const body = JSON.stringify({ email, password: "wrongpassword" });
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() },
      body,
    });

    const response = await POST(request);
    assert.equal(response.status, 401);
  });

  itWithContext("POST /api/auth/login rejects cross-origin", async () => {
    const { POST } = await import("../src/app/api/auth/login/route.ts");
    const body = JSON.stringify({ email: "test@example.com", password: "test" });
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { origin: "http://evil.com", "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() },
      body,
    });
    const response = await POST(request);
    assert.equal(response.status, 403);
  });
});

describe("application-level: rate limiting", () => {
  after(() => {
    resetMockCookies();
  });

  itWithContext("login rate limit blocks after max attempts", async () => {
    const { consumeLoginAttempt, loginLimitPerWindow } = await import("../src/lib/auth/attempt-limit.ts");
    const { POST } = await import("../src/app/api/auth/login/route.ts");

    const email = fixtureEmail("rate-login");
    const limit = loginLimitPerWindow();

    // Consume all allowed attempts
    for (let i = 0; i < limit; i++) {
      const decision = consumeLoginAttempt({ email, clientAddress: "127.0.0.1" });
      assert.equal(decision.allowed, true, `attempt ${i + 1} should be allowed`);
    }

    // Next attempt should be blocked
    const blocked = consumeLoginAttempt({ email, clientAddress: "127.0.0.1" });
    assert.equal(blocked.allowed, false, "attempt over limit should be blocked");
    assert.equal(blocked.scope, "account");

    // API should return 429
    resetMockCookies();
    const body = JSON.stringify({ email, password: "test" });
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() },
      body,
    });
    const response = await POST(request);
    assert.equal(response.status, 429);
  });

  itWithContext("signup rate limit blocks after max attempts", async () => {
    const { consumeSignupAttempt, signupLimitPerWindow } = await import("../src/lib/auth/attempt-limit.ts");
    const { POST } = await import("../src/app/api/auth/signup/route.ts");

    const email = fixtureEmail("rate-signup");
    const limit = signupLimitPerWindow();

    // Consume all allowed attempts
    for (let i = 0; i < limit; i++) {
      const decision = consumeSignupAttempt({ email, clientAddress: "127.0.0.1" });
      assert.equal(decision.allowed, true, `attempt ${i + 1} should be allowed`);
    }

    // Next attempt should be blocked
    const blocked = consumeSignupAttempt({ email, clientAddress: "127.0.0.1" });
    assert.equal(blocked.allowed, false, "attempt over limit should be blocked");

    // API should return 429
    resetMockCookies();
    const body = JSON.stringify({ email, password: "testpassword123" });
    const request = new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() },
      body,
    });
    const response = await POST(request);
    assert.equal(response.status, 429);
  });

  itWithContext("successful login resets the account bucket", async () => {
    const { consumeLoginAttempt, resetLoginAttempts, loginLimitPerWindow } = await import("../src/lib/auth/attempt-limit.ts");

    const email = fixtureEmail("rate-reset");
    const limit = loginLimitPerWindow();

    // Fill up the bucket
    for (let i = 0; i < limit; i++) {
      consumeLoginAttempt({ email, clientAddress: null });
    }

    // Should be blocked
    const blocked = consumeLoginAttempt({ email, clientAddress: null });
    assert.equal(blocked.allowed, false);

    // Reset after successful login
    resetLoginAttempts(email);

    // Should be allowed again
    const allowed = consumeLoginAttempt({ email, clientAddress: null });
    assert.equal(allowed.allowed, true, "should be allowed after reset");
  });
});
