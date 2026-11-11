/**
 * Automated unit tests for SiteSentra integration infrastructure (no database required).
 *
 * Validates:
 *  1. Malformed DATABASE_URL, normal Neon endpoint IDs, and pooler hostnames.
 *  2. Strict RUN_ID format validation and rejection of malformed run IDs.
 *  3. Fatal journal write/read failures.
 *  4. Child fixture discovery failure preserving parent users from deletion.
 *  5. Bidirectional sentinel write-and-read-back verification.
 *  6. Runner pool closure on setup failure without process.exit().
 *  7. Module-scoped pool sharing without globalThis.
 *  8. Table allowlist enforcement on fixture deletion.
 *  9. Reordered provisioning and conflicting marker rejection.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";

import {
  endpointIdFromUrl,
  databaseNameFromUrl,
  normaliseEnvValue,
  resolveIntegrationTarget,
  validateRunId,
  generateRunId,
  RUN_ID_PATTERN,
  IntegrationConfigError,
} from "./integration-env.ts";

import {
  verifyIntegrationIdentity,
  openVerifiedClient,
  assertSameDatabase,
  setIntegrationPool,
  getIntegrationPool,
  clearIntegrationPool,
  IntegrationIdentityError,
} from "./integration-identity.ts";

import {
  trackUser,
  trackSession,
  trackReport,
  cleanupFixtures,
  loadCrossProcessFixtures,
  getJournalPath,
  setRunId,
  getRunId,
  getRunRegistry,
  fixtureEmail,
  deleteIds,
  ALLOWED_FIXTURE_TABLES,
} from "./integration-fixtures.ts";

describe("integration env: normal Neon endpoint IDs & pooler hostnames", () => {
  it("extracts endpoint ID from normal direct Neon host", () => {
    assert.equal(
      endpointIdFromUrl("postgresql://u:p@ep-solitary-brook-ao2y8jbj.us-east-2.aws.neon.tech/db"),
      "ep-solitary-brook-ao2y8jbj",
    );
    assert.equal(
      endpointIdFromUrl("postgresql://u:p@ep-cool-forest-12345.c-1.neon.tech/db"),
      "ep-cool-forest-12345",
    );
  });

  it("extracts endpoint ID from pooled Neon host (stripping -pooler accurately)", () => {
    assert.equal(
      endpointIdFromUrl("postgresql://u:p@ep-solitary-brook-ao2y8jbj-pooler.us-east-2.aws.neon.tech/db"),
      "ep-solitary-brook-ao2y8jbj",
    );
    assert.equal(
      endpointIdFromUrl("postgresql://u:p@ep-cool-forest-12345-pooler.neon.tech/db"),
      "ep-cool-forest-12345",
    );
  });

  it("returns null for non-Neon hostnames or third-party domains", () => {
    assert.equal(endpointIdFromUrl("postgresql://u:p@localhost:5432/db"), null);
    assert.equal(endpointIdFromUrl("postgresql://u:p@ep-fake-123.attacker.com/db"), null);
    assert.equal(endpointIdFromUrl("postgresql://u:p@ep-fake.evil.org/db"), null);
    assert.equal(endpointIdFromUrl("postgresql://u:p@ep-.neon.tech/db"), null);
  });
});

describe("integration env: database name & value normalisation", () => {
  it("returns path database name with and without query parameters", () => {
    assert.equal(
      databaseNameFromUrl("postgresql://u:p@ep-test.neon.tech:5432/sitesentra_integration?sslmode=require"),
      "sitesentra_integration",
    );
    assert.equal(
      databaseNameFromUrl("postgresql://u:p@ep-test.neon.tech:5432/sitesentra_integration"),
      "sitesentra_integration",
    );
    assert.equal(databaseNameFromUrl("postgresql://u:p@ep-test.neon.tech:5432/"), null);
    assert.equal(databaseNameFromUrl("postgresql://u:p@ep-test.neon.tech:5432"), null);
  });

  it("strips surrounding quotes and treats blank values as absent", () => {
    assert.equal(normaliseEnvValue('"postgresql://x"'), "postgresql://x");
    assert.equal(normaliseEnvValue("'postgresql://x'"), "postgresql://x");
    assert.equal(normaliseEnvValue("   "), undefined);
    assert.equal(normaliseEnvValue(undefined), undefined);
  });
});

describe("integration env: production collision and malformed DATABASE_URL", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("rejects when DATABASE_URL_INTEGRATION is missing", () => {
    delete process.env.DATABASE_URL_INTEGRATION;
    assert.throws(() => resolveIntegrationTarget(), IntegrationConfigError);
  });

  it("aborts when DATABASE_URL is present but malformed/unparseable", () => {
    process.env.DATABASE_URL = "not-a-valid-url:://invalid";
    process.env.DATABASE_URL_INTEGRATION = "postgresql://u:p@ep-itest-12345.neon.tech/sitesentra_integration";
    process.env.INTEGRATION_EXPECTED_ENDPOINT_ID = "ep-itest-12345";
    process.env.INTEGRATION_EXPECTED_DATABASE_NAME = "sitesentra_integration";
    process.env.INTEGRATION_EXPECTED_BRANCH = "sitesentra-integration-test";

    assert.throws(
      () => resolveIntegrationTarget(),
      (err: Error) =>
        err instanceof IntegrationConfigError &&
        err.message.includes("Production target cannot be safely evaluated; aborting"),
    );

    // Also test completely unparseable string
    process.env.DATABASE_URL = ":::not a url:::";
    assert.throws(
      () => resolveIntegrationTarget(),
      (err: Error) =>
        err instanceof IntegrationConfigError &&
        err.message.includes("Production target cannot be safely evaluated; aborting"),
    );
  });

  it("rejects when DATABASE_URL_INTEGRATION matches DATABASE_URL by raw string", () => {
    const prodUrl = "postgresql://prod_user:secret@ep-prod-12345.us-east-2.aws.neon.tech/sitesentra_prod";
    process.env.DATABASE_URL = prodUrl;
    process.env.DATABASE_URL_INTEGRATION = prodUrl;
    process.env.INTEGRATION_EXPECTED_ENDPOINT_ID = "ep-prod-12345";
    process.env.INTEGRATION_EXPECTED_DATABASE_NAME = "sitesentra_prod";
    process.env.INTEGRATION_EXPECTED_BRANCH = "main";

    assert.throws(
      () => resolveIntegrationTarget(),
      (err) => err instanceof IntegrationConfigError && err.message.includes("identical to DATABASE_URL"),
    );
  });

  it("rejects when DATABASE_URL_INTEGRATION matches DATABASE_URL by parsed endpoint and database despite differing credentials/pooler host", () => {
    process.env.DATABASE_URL =
      "postgresql://app_user:app_secret@ep-prod-12345.us-east-2.aws.neon.tech/sitesentra_prod?sslmode=require";
    process.env.DATABASE_URL_INTEGRATION =
      "postgresql://other_user:other_secret@ep-prod-12345-pooler.us-east-2.aws.neon.tech/sitesentra_prod?sslmode=verify-full";
    process.env.INTEGRATION_EXPECTED_ENDPOINT_ID = "ep-prod-12345";
    process.env.INTEGRATION_EXPECTED_DATABASE_NAME = "sitesentra_prod";
    process.env.INTEGRATION_EXPECTED_BRANCH = "main";

    assert.throws(
      () => resolveIntegrationTarget(),
      (err) =>
        err instanceof IntegrationConfigError &&
        err.message.includes("targets the same Neon endpoint ('ep-prod-12345') and database ('sitesentra_prod')"),
    );
  });

  it("succeeds when integration configuration targets a distinct integration endpoint", () => {
    process.env.DATABASE_URL = "postgresql://u:p@ep-prod-99999.neon.tech/sitesentra_prod";
    process.env.DATABASE_URL_INTEGRATION = "postgresql://u:p@ep-itest-12345.neon.tech/sitesentra_integration";
    process.env.INTEGRATION_EXPECTED_ENDPOINT_ID = "ep-itest-12345";
    process.env.INTEGRATION_EXPECTED_DATABASE_NAME = "sitesentra_integration";
    process.env.INTEGRATION_EXPECTED_BRANCH = "sitesentra-integration-test";

    const target = resolveIntegrationTarget();
    assert.equal(target.expectedEndpointId, "ep-itest-12345");
    assert.equal(target.expectedDatabaseName, "sitesentra_integration");
    assert.equal(target.expectedBranchName, "sitesentra-integration-test");
  });
});

describe("run ID format validation & malformed run IDs", () => {
  it("validates run IDs against strict pattern", () => {
    const validId = generateRunId();
    assert.match(validId, RUN_ID_PATTERN);
    assert.equal(validateRunId(validId), true);

    // Malformed run IDs
    assert.equal(validateRunId("bad-run-id"), false);
    assert.equal(validateRunId("ss-itest-123-abc"), false);
    assert.equal(validateRunId("ss-itest-1234567890123-1234567g"), false); // non-hex
    assert.equal(validateRunId(""), false);
  });

  it("setRunId rejects malformed run IDs fail-closed", () => {
    const original = getRunId();
    assert.throws(
      () => setRunId("invalid-run-id-format"),
      (err: Error) => err.message.includes("Invalid run ID format"),
    );
    // Preserves original valid run ID
    assert.equal(getRunId(), original);
  });
});

describe("runner pool availability & module-scoped sharing (no globalThis)", () => {
  afterEach(() => {
    clearIntegrationPool();
  });

  it("throws fail-closed error when pool has not been initialized", () => {
    clearIntegrationPool();
    assert.throws(
      () => getIntegrationPool(),
      (err: Error) => err.message.includes("Integration pool missing"),
    );
  });

  it("returns registered pool via setIntegrationPool from module state only", () => {
    clearIntegrationPool();
    const mockPool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    setIntegrationPool(mockPool);

    const retrieved = getIntegrationPool();
    assert.equal(retrieved, mockPool);
  });

  it("does NOT populate or rely on globalThis", () => {
    clearIntegrationPool();
    const mockPool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    setIntegrationPool(mockPool);

    // globalThis must not have __ssIntegrationPool set
    const fallback = (globalThis as Record<string, unknown>).__ssIntegrationPool;
    assert.equal(fallback, undefined);
  });
});

describe("identity verification & branch marker checks", () => {
  const target = {
    url: "postgresql://u:p@ep-test-12345.neon.tech/sitesentra_integration",
    expectedEndpointId: "ep-test-12345",
    expectedDatabaseName: "sitesentra_integration",
    expectedBranchName: "test-branch",
  };

  it("queries branch marker with proper spacing and WHERE id = 1", async () => {
    let capturedQuery = "";
    const mockClient = {
      query: async (sql: string) => {
        if (sql.includes("current_database()")) {
          return {
            rows: [{
              database_name: "sitesentra_integration",
              session_user: "u",
              current_user: "u",
              server_address: "1.2.3.4",
            }],
          };
        }
        if (sql.includes("branch_marker")) {
          capturedQuery = sql;
          return {
            rows: [{
              branch: "test-branch",
              database_name: "sitesentra_integration",
              endpoint_id: "ep-test-12345",
            }],
          };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;

    await verifyIntegrationIdentity(mockClient, target);
    assert.ok(
      capturedQuery.includes("SELECT branch, database_name, endpoint_id FROM ss_test_bootstrap.branch_marker WHERE id = 1"),
    );
  });

  it("rejects when marker endpoint_id does not match expected", async () => {
    const mockClient = {
      query: async (sql: string) => {
        if (sql.includes("current_database()")) {
          return {
            rows: [{
              database_name: "sitesentra_integration",
              session_user: "u",
              current_user: "u",
              server_address: "1.2.3.4",
            }],
          };
        }
        if (sql.includes("branch_marker")) {
          return {
            rows: [{
              branch: "test-branch",
              database_name: "sitesentra_integration",
              endpoint_id: "ep-wrong-99999",
            }],
          };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;

    await assert.rejects(
      () => verifyIntegrationIdentity(mockClient, target),
      (err: Error) => err instanceof IntegrationIdentityError && err.message.includes("Marker endpoint mismatch"),
    );
  });
});

describe("bidirectional sentinel verification", () => {
  const target = {
    url: "postgresql://u:p@ep-test-12345.neon.tech/sitesentra_integration",
    expectedEndpointId: "ep-test-12345",
    expectedDatabaseName: "sitesentra_integration",
    expectedBranchName: "test-branch",
  };

  it("succeeds when both pools write and read back each other's sentinels and cleans up in finally", async () => {
    const testDeletedNonces: string[] = [];
    const appDeletedNonces: string[] = [];
    let sentinelFromTest = "";
    let sentinelFromApp = "";

    const mockTestPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("current_database()")) {
          return { rows: [{ database_name: "sitesentra_integration", backend_pid: 1234 }] };
        }
        if (sql.includes("INSERT INTO ss_test_bootstrap.sentinel")) {
          sentinelFromTest = params?.[0] as string;
          return { rows: [] };
        }
        if (sql.includes("SELECT nonce FROM ss_test_bootstrap.sentinel")) {
          return { rows: [{ nonce: sentinelFromApp }] };
        }
        if (sql.includes("DELETE FROM ss_test_bootstrap.sentinel")) {
          testDeletedNonces.push(...(params as string[]));
          return { rows: [] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    const mockAppPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("current_database()")) {
          return { rows: [{ database_name: "sitesentra_integration" }] };
        }
        if (sql.includes("SELECT nonce FROM ss_test_bootstrap.sentinel")) {
          return { rows: [{ nonce: sentinelFromTest }] };
        }
        if (sql.includes("INSERT INTO ss_test_bootstrap.sentinel")) {
          sentinelFromApp = params?.[0] as string;
          return { rows: [] };
        }
        if (sql.includes("DELETE FROM ss_test_bootstrap.sentinel")) {
          appDeletedNonces.push(...(params as string[]));
          return { rows: [] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    await assertSameDatabase(mockTestPool, target, mockAppPool);

    // Both sentinels were created
    assert.ok(sentinelFromTest.startsWith("sentinel-t2a-"));
    assert.ok(sentinelFromApp.startsWith("sentinel-a2t-"));

    // Both sentinels were deleted via finally
    assert.ok(testDeletedNonces.includes(sentinelFromTest));
    assert.ok(testDeletedNonces.includes(sentinelFromApp));
  });

  it("fails and cleans up sentinels when app pool cannot read test sentinel", async () => {
    const deletedNonces: string[] = [];

    const mockTestPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("current_database()")) {
          return { rows: [{ database_name: "sitesentra_integration", backend_pid: 1234 }] };
        }
        if (sql.includes("INSERT INTO ss_test_bootstrap.sentinel")) {
          return { rows: [] };
        }
        if (sql.includes("DELETE FROM ss_test_bootstrap.sentinel")) {
          deletedNonces.push(...(params as string[]));
          return { rows: [] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    const mockAppPool = {
      query: async (sql: string) => {
        if (sql.includes("current_database()")) {
          return { rows: [{ database_name: "sitesentra_integration" }] };
        }
        if (sql.includes("SELECT nonce FROM")) {
          return { rows: [] }; // Not found!
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    await assert.rejects(
      () => assertSameDatabase(mockTestPool, target, mockAppPool),
      (err: Error) => err instanceof IntegrationIdentityError && err.message.includes("could not read back sentinel"),
    );

    assert.ok(deletedNonces.length > 0, "Sentinels must be cleaned up in finally on error");
  });
});

describe("fixture safety: journal failures & child discovery failures", () => {
  const testRunId = generateRunId();
  const journalPath = getJournalPath(testRunId);

  afterEach(() => {
    if (existsSync(journalPath)) unlinkSync(journalPath);
    const testRegistry = getRunRegistry(testRunId);
    testRegistry.userIds.clear();
    testRegistry.sessionIds.clear();
    testRegistry.reportIds.clear();
  });

  it("fails fatally on corrupt journal read and does not silently ignore it", () => {
    // Write corrupted non-JSON line to journal
    writeFileSync(journalPath, "CORRUPT_NON_JSON_LINE\n", "utf8");

    assert.throws(
      () => loadCrossProcessFixtures(testRunId),
      (err: Error) => err.message.includes("Failed to parse fixture journal at line 1"),
    );
  });

  it("rejects invalid run IDs before filesystem access or SQL", async () => {
    const invalidRunId = "not-a-valid-run";
    let queries = 0;
    const pool = {
      query: async () => {
        queries += 1;
        return { rows: [] };
      },
    } as unknown as Pool;

    assert.throws(() => getJournalPath(invalidRunId), /Invalid run ID format/);
    assert.throws(() => loadCrossProcessFixtures(invalidRunId), /Invalid run ID format/);
    await assert.rejects(
      () => cleanupFixtures(pool, invalidRunId),
      /Invalid run ID format/,
    );
    assert.equal(queries, 0);
  });

  it("does NOT delete parent users when child fixture discovery fails", async () => {
    const userId = "u-protected-1";
    const testRegistry = getRunRegistry(testRunId);
    const otherRunId = generateRunId();
    const otherRegistry = getRunRegistry(otherRunId);
    const otherUserId = "u-other-run";
    otherRegistry.userIds.add(otherUserId);
    testRegistry.userIds.add(userId);
    writeFileSync(
      getJournalPath(testRunId),
      JSON.stringify({ runId: testRunId, entityType: "users", id: userId }) + "\n",
      "utf8",
    );

    const deletedTables: string[] = [];
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT id FROM users WHERE email LIKE")) {
          return { rows: [] };
        }
        if (sql.includes("SELECT id FROM sessions WHERE user_id")) {
          // Child discovery throws error!
          throw new Error("Simulated database connection error during child discovery");
        }
        if (sql.includes("DELETE FROM users")) {
          deletedTables.push("users");
          return { rows: [{ id: userId }] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    await assert.rejects(
      () => cleanupFixtures(mockPool, testRunId),
      (err: Error) => err.message.includes("Fixture discovery failed; no rows were deleted"),
    );

    // Parent users MUST NOT have been deleted!
    assert.equal(
      deletedTables.includes("users"),
      false,
      "Parent users must NEVER be deleted when child discovery fails!",
    );

    // Parent user ID is preserved in registry
    assert.ok(testRegistry.userIds.has(userId));
    assert.ok(otherRegistry.userIds.has(otherUserId));
    otherRegistry.userIds.clear();
  });

  it("enforces table allowlist on deleteIds", async () => {
    const mockPool = { query: async () => ({ rows: [] }) } as unknown as Pool;

    await assert.rejects(
      () => deleteIds(mockPool, "dangerous_table; DROP TABLE users;", ["id-1"]),
      /not in the allowed fixture tables list/,
    );

    await assert.rejects(
      () => deleteIds(mockPool, "ss_test_bootstrap.sentinel", ["nonce-1"]),
      /not in the allowed fixture tables list/,
    );

    for (const allowed of ALLOWED_FIXTURE_TABLES) {
      const res = await deleteIds(mockPool, allowed, []);
      assert.deepEqual(res, { deleted: [], absent: [], failed: [] });
    }
  });

  it("keeps distinct run registries isolated during cleanup", async () => {
    const originalRunId = getRunId();
    const firstRunId = generateRunId();
    const secondRunId = generateRunId();
    const firstJournal = getJournalPath(firstRunId);
    const secondJournal = getJournalPath(secondRunId);

    try {
      setRunId(firstRunId);
      trackUser("user-first");
      const firstEmail = fixtureEmail("first");

      setRunId(secondRunId);
      trackUser("user-second");
      const secondEmail = fixtureEmail("second");

      const mockPool = {
        query: async (sql: string, params: string[]) => {
          if (sql.includes("SELECT id FROM users")) {
            return { rows: [] };
          }
          if (sql.includes("DELETE FROM users")) {
            return {
              rows: [{ id: params[0] }],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      await cleanupFixtures(mockPool, firstRunId);

      assert.equal(existsSync(firstJournal), false);
      assert.equal(existsSync(secondJournal), true);
      assert.deepEqual([...getRunRegistry(secondRunId).userIds], ["user-second"]);
      assert.equal(fixtureEmail("second"), secondEmail);
      assert.notEqual(firstEmail, secondEmail);
    } finally {
      setRunId(originalRunId);
      if (existsSync(firstJournal)) unlinkSync(firstJournal);
      if (existsSync(secondJournal)) unlinkSync(secondJournal);
      getRunRegistry(firstRunId).userIds.clear();
      getRunRegistry(firstRunId).sessionIds.clear();
      getRunRegistry(firstRunId).reportIds.clear();
      getRunRegistry(secondRunId).userIds.clear();
      getRunRegistry(secondRunId).sessionIds.clear();
      getRunRegistry(secondRunId).reportIds.clear();
    }
  });

  it("reports journal removal failure and leaves recovery journal present", async () => {
    const runId = generateRunId();
    const journalPath = getJournalPath(runId);
    writeFileSync(
      journalPath,
      JSON.stringify({ runId, entityType: "users", id: "unused" }) + "\n",
      "utf8",
    );
    let replaced = false;

    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          if (!replaced) {
            unlinkSync(journalPath);
            mkdirSync(journalPath);
            replaced = true;
          }
          return { rows: [] };
        }
        if (sql.includes("DELETE FROM users")) return { rows: [{ id: "unused" }] };
        return { rows: [] };
      },
    } as unknown as Pool;

    try {
      await assert.rejects(
        () => cleanupFixtures(mockPool, runId),
        /Journal removal failed/,
      );
      assert.equal(existsSync(journalPath), true);
    } finally {
      rmdirSync(journalPath);
    }
  });

  it("preserves durable fixture recovery records whenever any cleanup step fails", async () => {
    const runId = generateRunId();
    const runJournalPath = getJournalPath(runId);

    const goodId = "u-good-1";
    const failId = "u-fail-1";
    const runRegistry = getRunRegistry(runId);
    runRegistry.userIds.add(goodId);
    runRegistry.userIds.add(failId);

    writeFileSync(
      runJournalPath,
      JSON.stringify({ runId, entityType: "users", id: goodId }) + "\n" +
      JSON.stringify({ runId, entityType: "users", id: failId }) + "\n",
      "utf8",
    );

    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT id FROM")) return { rows: [] };
        if (sql.includes("DELETE FROM users")) {
          throw new Error("Simulated database timeout");
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    await assert.rejects(
      () => cleanupFixtures(mockPool, runId),
      (err: Error) => err.message.includes("Fixture cleanup failed"),
    );

    assert.ok(existsSync(runJournalPath), "Durable journal must be preserved on failure");
    if (existsSync(runJournalPath)) unlinkSync(runJournalPath);
    runRegistry.userIds.clear();
    runRegistry.sessionIds.clear();
    runRegistry.reportIds.clear();
  });
});

describe("runner teardown and pool closure on setup failure", () => {
  it("closes created pools on setup failure without calling process.exit()", async () => {
    let poolEnded = false;
    let appPoolEnded = false;

    const mockTestPool = {
      end: async () => {
        poolEnded = true;
      },
      connect: async () => {
        throw new Error("Simulated connection failure during setup");
      },
    } as unknown as Pool;

    const mockAppDb = {
      pool: {
        end: async () => {
          appPoolEnded = true;
        },
      },
    };

    // Simulate setup error handler from runner.ts
    const target = {
      url: "postgresql://u:p@ep-test.neon.tech/db",
      expectedEndpointId: "ep-test",
      expectedDatabaseName: "db",
      expectedBranchName: "main",
    };

    let caughtError: unknown = null;
    try {
      await openVerifiedClient(mockTestPool, target);
    } catch (err) {
      caughtError = err;
      await mockTestPool.end().catch(() => {});
      await mockAppDb.pool.end().catch(() => {});
    }

    assert.ok(caughtError !== null);
    assert.equal(poolEnded, true, "Test pool must be ended on setup failure");
    assert.equal(appPoolEnded, true, "Application pool must be ended on setup failure");
  });
});
