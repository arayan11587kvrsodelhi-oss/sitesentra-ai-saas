/**
 * SiteSentra — integration tests for database-tier session & isolation behavior.
 *
 * SCOPE & COVERAGE NOTE:
 * These tests validate direct database schema constraints, queries, and SQL
 * isolation rules (sessions, token hashes, scan report tenant isolation).
 * They validate the database tier directly against an isolated integration DB.
 * Application-level route handlers (/api/auth/login, /api/auth/signup,
 * /api/auth/logout) and cookie/session helpers (createSession, getCurrentUser)
 * are exercised in `tests/integration-app.test.ts`. This suite validates SQL
 * behavior and does not claim full route-level authentication integration coverage.
 *
 * Fixture discipline:
 *  - Every row created here is registered in `integration-fixtures.ts` by id.
 *  - Teardown deletes only those ids, child tables first.
 *  - There is no unqualified `DELETE FROM <table>`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import type { Pool } from "pg";

import { fixtureEmail, trackUser, trackSession, trackReport } from "./integration-fixtures.ts";
import { getIntegrationPool } from "./integration-identity.ts";
import { hashPassword, verifyPassword } from "../src/lib/auth/password.ts";

/** Verified pool obtained from the identity-verified runner. */
const pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const actual = getIntegrationPool();
    const val = (actual as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? val.bind(actual) : val;
  },
});

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

async function createUser(label: string, password = "testpassword123"): Promise<string> {
  const passwordHash = await hashPassword(password);
  const result = await pool.query<{ id: string }>(
    "INSERT INTO users (id, email, password_hash) VALUES (gen_random_uuid(), $1, $2) RETURNING id",
    [fixtureEmail(label), passwordHash],
  );
  return trackUser(result.rows[0].id);
}

async function createSessionRow(userId: string, opts: { expired?: boolean; revoked?: boolean } = {}): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + (opts.expired ? -86400 : 604800) * 1000);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [userId, tokenHash, expiresAt, opts.revoked ? new Date() : null],
  );
  return { token, id: trackSession(result.rows[0].id) };
}

async function createReport(userId: string, host: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO scan_reports (id, user_id, input_url, target_host, status, report, summary)
     VALUES (gen_random_uuid(), $1, $2, $3, 'completed', '{}', '{}') RETURNING id`,
    [userId, `https://${host}/`, host],
  );
  return trackReport(result.rows[0].id);
}

async function validateSession(userId: string, token: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.user_id = $2
       AND s.revoked_at IS NULL AND s.expires_at > now()
     LIMIT 1`,
    [hashToken(token), userId],
  );
  return (result.rowCount ?? 0) > 0;
}

describe("integration: direct SQL session and report isolation (database tier)", () => {
  let userA: string;
  let userB: string;
  let tokenA = "";

  before(async () => {
    // Unique fixtures per run — never a fixed email that could collide with
    // rows left behind by an earlier aborted run.
    userA = await createUser("alice", "AlicePassword123!");
    userB = await createUser("bob", "BobPassword123!");
  });

  after(async () => {
    // Cleanup itself is owned by runner.ts (after hook) so it also runs when
    // an assertion throws.
    assert.ok(userA && userB);
  });

  it("registers a user and verifies real scrypt password hash with verifyPassword", async () => {
    const result = await pool.query<{ id: string; email: string; password_hash: string }>(
      "SELECT id, email, password_hash FROM users WHERE id = $1",
      [userA],
    );
    assert.equal(result.rows.length, 1, "user should exist after registration");
    assert.equal(result.rows[0].id, userA, "returned id should match");

    // Real password hash validation (not placeholder)
    assert.ok(result.rows[0].password_hash.startsWith("scrypt$"), "password hash must be scrypt format");
    const valid = await verifyPassword("AlicePassword123!", result.rows[0].password_hash);
    assert.equal(valid, true, "application verifyPassword must validate original password");
    const invalid = await verifyPassword("wrong-password", result.rows[0].password_hash);
    assert.equal(invalid, false, "application verifyPassword must reject incorrect password");
  });

  it("creates a valid session row in the database", async () => {
    const session = await createSessionRow(userA);
    tokenA = session.token;

    const result = await pool.query<{ user_id: string; revoked_at: Date | null; expires_at: Date }>(
      "SELECT user_id, revoked_at, expires_at FROM sessions WHERE id = $1",
      [session.id],
    );
    assert.equal(result.rows.length, 1, "session should exist after creation");
    assert.equal(result.rows[0].user_id, userA);
    assert.equal(result.rows[0].revoked_at, null, "session should not be revoked yet");
    assert.ok(result.rows[0].expires_at > new Date(), "session should not be expired");
  });

  it("validates a session token hash against the database", async () => {
    assert.equal(await validateSession(userA, tokenA), true);
  });

  it("rejects a forged session token", async () => {
    assert.equal(await validateSession(userA, "not-a-real-token-0000000000000000000000000000"), false);
  });

  it("rejects a token belonging to another user", async () => {
    const sessionB = await createSessionRow(userB);
    assert.equal(await validateSession(userA, sessionB.token), false, "token must not validate for wrong user");
  });

  it("rejects an expired session", async () => {
    const expired = await createSessionRow(userA, { expired: true });
    assert.equal(await validateSession(userA, expired.token), false);
  });

  it("rejects a revoked session", async () => {
    const revoked = await createSessionRow(userA, { revoked: true });
    assert.equal(await validateSession(userA, revoked.token), false);
  });

  it("revokes the session row in the database", async () => {
    const session = await createSessionRow(userA);
    const updated = await pool.query(
      "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id",
      [session.id],
    );
    assert.equal(updated.rowCount, 1, "exactly one session row must be revoked");
    assert.equal(await validateSession(userA, session.token), false);
  });

  it("prevents token reuse after database revocation", async () => {
    const session = await createSessionRow(userA);
    await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [session.id]);
    assert.equal(await validateSession(userA, session.token), false, "replayed token must be rejected after revocation");
  });

  it("two users cannot access each other's scan reports via tenant-scoped queries", async () => {
    const reportA = await createReport(userA, "alice.example.com");
    const reportB = await createReport(userB, "bob.example.com");

    const readAsA = await pool.query("SELECT id FROM scan_reports WHERE id = $1 AND user_id = $2", [reportB, userA]);
    assert.equal(readAsA.rowCount, 0, "User A must not see User B's report");

    const deleteAsA = await pool.query(
      "DELETE FROM scan_reports WHERE id = $1 AND user_id = $2 RETURNING id",
      [reportB, userA],
    );
    assert.equal(deleteAsA.rowCount, 0, "User A must not delete User B's report");

    // reportB was not deleted, so it is still tracked for cleanup.
    const verifyB = await pool.query("SELECT id FROM scan_reports WHERE id = $1", [reportB]);
    assert.equal(verifyB.rowCount, 1, "User B's report must survive");

    const ownReport = await pool.query("SELECT id FROM scan_reports WHERE id = $1 AND user_id = $2", [reportA, userA]);
    assert.equal(ownReport.rowCount, 1, "User A must see their own report");
  });
});

describe("integration: SSRF protection (no database required)", () => {
  it("rejects private and metadata IP literals", async () => {
    const { parseTargetUrl, isTargetRejected } = await import("../src/lib/scanner/target-guard.ts");

    const privateUrls = [
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
    ];
    for (const url of privateUrls) {
      try {
        parseTargetUrl(url);
        assert.fail(`${url} should have been rejected`);
      } catch (error) {
        assert.ok(isTargetRejected(error), `${url} should produce TargetRejectedError`);
      }
    }
  });
});
