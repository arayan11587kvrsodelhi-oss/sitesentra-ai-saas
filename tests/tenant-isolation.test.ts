/**
 * SiteSentra — tenant isolation integration tests.
 *
 * These tests verify cross-user isolation under Row Level Security (RLS).
 * They run against a disposable PostgreSQL database only.
 *
 * Prerequisites (provision once per test run):
 *  1. CREATE SCHEMA bootstrap; CREATE SCHEMA maintenance;
 *  2. CREATE ROLE bootstrap_owner NOLOGIN NOBYPASSRLS NOINHERIT;
 *  3. CREATE ROLE sitesentra_app NOLOGIN NOBYPASSRLS NOINHERIT;
 *  4. CREATE ROLE sitesentra_login LOGIN PASSWORD 'test' NOBYPASSRLS NOINHERIT;
 *  5. GRANT sitesentra_app TO sitesentra_login;
 *  6. GRANT USAGE ON SCHEMA public, auth, bootstrap, maintenance TO sitesentra_login, sitesentra_app;
 *  7. GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sitesentra_app;
 *  8. Create SECURITY DEFINER functions in bootstrap schema owned by bootstrap_owner
 *  9. REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA bootstrap FROM PUBLIC;
 *  10. GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA bootstrap TO sitesentra_login;
 *  11. INSERT INTO bootstrap.test_marker (id, value) VALUES ('test', 'disposable');
 *
 * Run with:
 *   DATABASE_URL="postgresql://sitesentra_login:test@localhost:5432/sitesentra_test" \
 *   NODE_ENV=test \
 *   node --test tests/tenant-isolation.test.ts
 */
import { describe, it, before, after } from "node:test";
import { equal, ok } from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { scanReports } from "@/db/schema";
import { withSiteSentraTransaction, TransactionError } from "@/lib/db/transaction";
import { verifyDisposableDb, acquireAndVerify } from "./disposable-db-gate";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL environment variable is required to run tenant-isolation tests. " +
    "Point it at a disposable PostgreSQL database (e.g. postgresql://sitesentra_login:test@localhost:5432/sitesentra_test)."
  );
}

// Shared gate config — every client must pass these checks before use.
const gateConfig = {
  url: databaseUrl,
  expectedDbNamePrefix: "sitesentra_test",
  expectedLoginRole: "sitesentra_login",
  markerSchema: "bootstrap",
  markerTableName: "test_marker",
};

describe("cross-user RLS isolation", () => {
  let pool: Pool;
  let userA: string;
  let userB: string;
  let reportA: string;
  let reportB: string;

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl });

    // Gate the provisioning client before any fixture mutation.
    const gateClient = await acquireAndVerify(pool, gateConfig);
    try {
      // Seed two synthetic users (as owner, since we need to create them)
      const resultA = await gateClient.query(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'scrypt$16384$8$1$$test') RETURNING id",
        [randomUUID(), `alice-${randomUUID()}@disposable.test`]
      );
      userA = resultA.rows[0].id;

      const resultB = await gateClient.query(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'scrypt$16384$8$1$$test') RETURNING id",
        [randomUUID(), `bob-${randomUUID()}@disposable.test`]
      );
      userB = resultB.rows[0].id;

      // Seed reports
      const reportAResult = await gateClient.query(
        "INSERT INTO scan_reports (id, user_id, input_url, target_host, status, report, summary) VALUES ($1, $2, $3, $4, 'completed', '{}', '{}') RETURNING id",
        [randomUUID(), userA, "https://alice.test", "alice.test"]
      );
      reportA = reportAResult.rows[0].id;

      const reportBResult = await gateClient.query(
        "INSERT INTO scan_reports (id, user_id, input_url, target_host, status, report, summary) VALUES ($1, $2, $3, $4, 'completed', '{}', '{}') RETURNING id",
        [randomUUID(), userB, "https://bob.test", "bob.test"]
      );
      reportB = reportBResult.rows[0].id;
    } finally {
      gateClient.release();
    }
  });

  after(async () => {
    // Cleanup fixtures
    const client = await acquireAndVerify(pool, gateConfig);
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM scan_reports WHERE user_id IN ($1, $2)", [userA, userB]);
      await client.query("DELETE FROM sessions WHERE user_id IN ($1, $2)", [userA, userB]);
      await client.query("DELETE FROM users WHERE id IN ($1, $2)", [userA, userB]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await pool.end();
  });

  // =========================================================================
  // Role and GUC behavior tests
  // =========================================================================

  describe("role and identity behavior", () => {
    it("session_user is login role, current_user changes with SET ROLE", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await client.query("BEGIN");

        // Before SET ROLE
        const before = await client.query("SELECT session_user, current_user");
        equal(before.rows[0].session_user, "sitesentra_login");
        equal(before.rows[0].current_user, "sitesentra_login");

        // After SET ROLE
        await client.query("SET ROLE sitesentra_app");
        const after = await client.query("SELECT session_user, current_user");
        equal(after.rows[0].session_user, "sitesentra_login");
        equal(after.rows[0].current_user, "sitesentra_app");

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("GUC resets to its original baseline after COMMIT", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        // Capture actual pre-transaction baseline
        const baselineBefore = await client.query(
          "SELECT current_setting('request.jwt.claim.sub', true) AS val"
        );
        const baselineVal = baselineBefore.rows[0].val;

        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query(
          "SELECT set_config('request.jwt.claim.sub', $1, true)",
          [userA]
        );

        const during = await client.query(
          "SELECT current_setting('request.jwt.claim.sub', true) AS val"
        );
        equal(during.rows[0].val, userA);

        await client.query("COMMIT");

        const after = await client.query(
          "SELECT current_setting('request.jwt.claim.sub', true) AS val"
        );
        equal(after.rows[0].val, baselineVal, "GUC should restore to baseline after COMMIT");
      } finally {
        client.release();
      }
    });

    it("GUC resets to its original baseline after ROLLBACK", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        // Capture actual pre-transaction baseline
        const baselineBefore = await client.query(
          "SELECT current_setting('request.jwt.claim.sub', true) AS val"
        );
        const baselineVal = baselineBefore.rows[0].val;

        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query(
          "SELECT set_config('request.jwt.claim.sub', $1, true)",
          [userA]
        );

        const during = await client.query(
          "SELECT current_setting('request.jwt.claim.sub', true) AS val"
        );
        equal(during.rows[0].val, userA);

        await client.query("ROLLBACK");

        const after = await client.query(
          "SELECT current_setting('request.jwt.claim.sub', true) AS val"
        );
        equal(after.rows[0].val, baselineVal, "GUC should restore to baseline after ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("connection reuse preserves identity reset after ROLLBACK", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        // First transaction
        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);
        await client.query("ROLLBACK");

        // Second transaction on same client
        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userB]);

        const check = await client.query(
          "SELECT current_setting('request.jwt.claim.sub', true) AS val"
        );
        equal(check.rows[0].val, userB, "Second transaction has correct identity");

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  });

  // =========================================================================
  // Cross-user isolation tests (NO user_id predicate in queries)
  // =========================================================================

  describe("cross-user isolation under RLS", () => {
    it("Alice cannot SELECT Bob's report", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);

        const result = await client.query(
          "SELECT id FROM scan_reports WHERE id = $1",
          [reportB]
        );

        equal(result.rowCount, 0, "User A should not see User B's report");

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("Alice cannot INSERT as Bob (SQLSTATE 42501)", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);

        let error: Error | null = null;
        try {
          await client.query(
            "INSERT INTO scan_reports (id, user_id, input_url, target_host, status, report, summary) VALUES ($1, $2, $3, $4, 'completed', '{}', '{}')",
            [randomUUID(), userB, "https://evil.test", "evil.test"]
          );
        } catch (err) {
          error = err as Error;
        }

        ok(error, "Cross-user INSERT must fail");
        const pgError = error as NodeJS.ErrnoException & { code?: string };
        equal(pgError.code, "42501", "Expected SQLSTATE 42501 (insufficient_privilege), got: " + (pgError.code ?? "unknown"));

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("Alice cannot UPDATE Bob's report", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);

        const result = await client.query(
          "UPDATE scan_reports SET status = 'failed' WHERE id = $1 RETURNING status",
          [reportB]
        );

        equal(result.rowCount, 0, "User A cannot update User B's report");

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("Alice cannot DELETE Bob's report", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);

        const result = await client.query(
          "DELETE FROM scan_reports WHERE id = $1 RETURNING id",
          [reportB]
        );

        equal(result.rowCount, 0, "User A cannot delete User B's report");

        // Verify report still exists
        const verify = await client.query(
          "SELECT id FROM scan_reports WHERE id = $1",
          [reportB]
        );
        equal(verify.rowCount, 1, "User B's report must survive");

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("Alice can SELECT her own report", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);

        const result = await client.query(
          "SELECT id FROM scan_reports WHERE id = $1",
          [reportA]
        );

        equal(result.rowCount, 1, "User A can read own report");

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("Alice can DELETE her own report", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await client.query("BEGIN");
        await client.query("SET ROLE sitesentra_app");
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);

        const result = await client.query(
          "DELETE FROM scan_reports WHERE id = $1 RETURNING id",
          [reportA]
        );

        equal(result.rowCount, 1, "User A can delete own report");

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  });

  // =========================================================================
  // Drizzle transaction wrapper tests
  // =========================================================================

  describe("Drizzle transaction wrapper", () => {
    const db = drizzle(pool);

    // Helper: exactly one release call per client, no double-release.
    // Calls release(error) to discard on failure, release(undefined) on success.
    function safeRelease(client: { release: (err?: Error) => void }, err: Error | null): void {
      client.release(err ?? undefined);
    }

    it("can read own report via transaction wrapper", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await withSiteSentraTransaction(db, client, userA, async (tx) => {
          const result = await tx.select({ id: scanReports.id })
            .from(scanReports)
            .where(sql`${scanReports.id} = ${reportA}`);

          equal(result.length, 1, "Can read own report via Drizzle tx");
        });
      } catch (err) {
        safeRelease(client, err as Error);
        throw err;
      }
      safeRelease(client, null);
    });

    it("cannot read other user's report via transaction wrapper", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      try {
        await withSiteSentraTransaction(db, client, userA, async (tx) => {
          const result = await tx.select({ id: scanReports.id })
            .from(scanReports)
            .where(sql`${scanReports.id} = ${reportB}`);

          equal(result.length, 0, "Cannot read other user's report via Drizzle tx");
        });
      } catch (err) {
        safeRelease(client, err as Error);
        throw err;
      }
      safeRelease(client, null);
    });

    it("cannot insert as another user via transaction wrapper", async () => {
      const client = await acquireAndVerify(pool, gateConfig);
      let error: Error | null = null;
      try {
        await withSiteSentraTransaction(db, client, userA, async (tx) => {
          await tx.insert(scanReports).values({
            userId: userB,
            inputUrl: "https://evil.test",
            targetHost: "evil.test",
            status: "completed",
            report: {},
            summary: {},
          });
        });
      } catch (err) {
        error = err as Error;
      }
      safeRelease(client, error);

      ok(error, "Cross-user INSERT via Drizzle tx should fail");
      const pgError2 = error as NodeJS.ErrnoException & { code?: string };
      equal(pgError2.code, "42501", "Expected SQLSTATE 42501");
    });
  });
});
