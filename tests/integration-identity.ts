/**
 * SiteSentra — integration database identity gate (fail closed).
 *
 * Proves, using the SAME connection the tests and the application will use,
 * that we are connected to the database the operator explicitly declared as the
 * integration target. Nothing here uses substring matching.
 *
 * Checks:
 *  1. `current_database()` equals the declared database name exactly.
 *  2. The server actually reached is the declared Neon endpoint — verified by
 *     the endpoint id in the connection string AND server address where available.
 *  3. The Neon branch is confirmed through the test marker table,
 *     which the provisioning step writes with the declared branch name,
 *     database name, and endpoint id.
 *     LIMITATION: An SQL connection inside PostgreSQL cannot independently query
 *     the Neon control plane to prove branch identity. Branch identity relies
 *     on endpoint-to-branch configuration and explicit operator confirmation.
 *  4. Both the test pool AND application pool verify database name and endpoint,
 *     followed by BIDIRECTIONAL sentinel verification:
 *       - Test pool writes nonce 1 -> Application pool reads nonce 1.
 *       - Application pool writes nonce 2 -> Test pool reads nonce 2.
 *     Both sentinel nonces are cleaned up in a finally block.
 *
 * If any value cannot be verified, the gate throws. It never "passes by default".
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { IntegrationTarget } from "./integration-env.ts";
import { databaseNameFromUrl, endpointIdFromUrl } from "./integration-env.ts";

export class IntegrationIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationIdentityError";
  }
}

export type VerifiedIdentity = {
  databaseName: string;
  sessionUser: string;
  currentUser: string;
  serverAddress: string | null;
  endpointId: string;
  branch: string;
};

/** Marker table written at provision time. */
export const BRANCH_MARKER_SCHEMA = "ss_test_bootstrap";
export const BRANCH_MARKER_TABLE = "branch_marker";

/** Module-scoped pool reference only — no globalThis sharing. */
let activeIntegrationPool: Pool | null = null;

export function setIntegrationPool(pool: Pool): void {
  activeIntegrationPool = pool;
}

export function getIntegrationPool(): Pool {
  if (activeIntegrationPool) {
    return activeIntegrationPool;
  }
  throw new Error(
    "Integration pool missing: run these tests through `npm run test:integration` or initialize with setIntegrationPool().",
  );
}

export function clearIntegrationPool(): void {
  activeIntegrationPool = null;
}

export async function verifyIntegrationIdentity(
  client: Pick<PoolClient, "query">,
  target: IntegrationTarget,
): Promise<VerifiedIdentity> {
  const identityResult = await client.query<{
    database_name: string;
    session_user: string;
    current_user: string;
    server_address: string | null;
  }>(
    `SELECT current_database() AS database_name,
            session_user::text AS session_user,
            current_user::text AS current_user,
            host(inet_server_addr()) AS server_address`,
  );
  const row = identityResult.rows[0];
  if (!row) throw new IntegrationIdentityError("Could not read database identity.");

  // 1. Exact database name.
  if (row.database_name !== target.expectedDatabaseName) {
    throw new IntegrationIdentityError(
      `Database mismatch: connected to '${row.database_name}', expected exactly '${target.expectedDatabaseName}'.`,
    );
  }

  // 1b. The URL itself must name that database too.
  const urlDatabase = databaseNameFromUrl(target.url);
  if (urlDatabase !== target.expectedDatabaseName) {
    throw new IntegrationIdentityError(
      `Connection string names database '${urlDatabase}', but INTEGRATION_EXPECTED_DATABASE_NAME is '${target.expectedDatabaseName}'.`,
    );
  }

  // 2. Endpoint id, from the URL and re-derived here for an explicit comparison.
  const urlEndpoint = endpointIdFromUrl(target.url);
  if (urlEndpoint !== target.expectedEndpointId) {
    throw new IntegrationIdentityError(
      `Endpoint mismatch: connection string targets '${urlEndpoint}', expected '${target.expectedEndpointId}'.`,
    );
  }

  // 3. Validate the marker table's branch, database_name, AND endpoint_id.
  // Note: The marker was written at provision time after operator confirmation.
  const marker = await client.query<{ branch: string; database_name: string; endpoint_id: string }>(
    `SELECT branch, database_name, endpoint_id FROM ${BRANCH_MARKER_SCHEMA}.${BRANCH_MARKER_TABLE} WHERE id = 1`,
  );
  const markerRow = marker.rows[0];
  if (!markerRow) {
    throw new IntegrationIdentityError(
      `Branch marker table '${BRANCH_MARKER_SCHEMA}.${BRANCH_MARKER_TABLE}' is empty; branch identity cannot be verified. Run the provisioning step first.`,
    );
  }
  if (markerRow.branch !== target.expectedBranchName) {
    throw new IntegrationIdentityError(
      `Branch mismatch: database was provisioned for branch '${markerRow.branch}', expected '${target.expectedBranchName}'.`,
    );
  }
  if (markerRow.database_name !== target.expectedDatabaseName) {
    throw new IntegrationIdentityError(
      `Marker database mismatch: marker says '${markerRow.database_name}', expected '${target.expectedDatabaseName}'.`,
    );
  }
  if (markerRow.endpoint_id !== target.expectedEndpointId) {
    throw new IntegrationIdentityError(
      `Marker endpoint mismatch: marker says '${markerRow.endpoint_id}', expected '${target.expectedEndpointId}'.`,
    );
  }

  return {
    databaseName: row.database_name,
    sessionUser: row.session_user,
    currentUser: row.current_user,
    serverAddress: row.server_address,
    endpointId: urlEndpoint,
    branch: markerRow.branch,
  };
}

/**
 * Opens a client from the pool, runs the gate, and hands the client back.
 */
export async function openVerifiedClient(
  pool: Pool,
  target: IntegrationTarget,
): Promise<{ client: PoolClient; identity: VerifiedIdentity }> {
  const client = await pool.connect();
  let operationError: unknown = null;
  try {
    const identity = await verifyIntegrationIdentity(client, target);
    return { client, identity };
  } catch (error) {
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Proves the application's shared `db` module and the test pool are talking to
 * the exact same physical database:
 *  1. Verifies database name on both pools.
 *  2. Bidirectional sentinel verification:
 *     - Test pool writes sentinel 1 -> Application pool reads sentinel 1.
 *     - Application pool writes sentinel 2 -> Test pool reads sentinel 2.
 *  3. Guaranteed cleanup of both sentinels in a finally block.
 */
export async function assertSameDatabase(
  testPool: Pick<Pool, "query">,
  target: IntegrationTarget,
  appPoolInstance?: Pick<Pool, "query">,
): Promise<void> {
  const testDbResult = await testPool.query<{ database_name: string; backend_pid: number }>(
    `SELECT current_database() AS database_name, pg_backend_pid() AS backend_pid`,
  );
  const viaApp = appPoolInstance
    ? { pool: appPoolInstance }
    : await import("../src/db/index.ts");
  const appDbResult = await viaApp.pool.query<{ database_name: string }>(
    `SELECT current_database() AS database_name`,
  );

  const testDb = testDbResult.rows[0]?.database_name;
  const appDb = appDbResult.rows[0]?.database_name;

  if (testDb !== target.expectedDatabaseName) {
    throw new IntegrationIdentityError(
      `Test pool is connected to '${testDb}', expected '${target.expectedDatabaseName}'.`,
    );
  }
  if (appDb !== target.expectedDatabaseName) {
    throw new IntegrationIdentityError(
      `Application DB module is connected to '${appDb}', expected '${target.expectedDatabaseName}'. Application and test pool do NOT share a database.`,
    );
  }

  // Bidirectional sentinel verification
  const nonceTestToApp = `sentinel-t2a-${Date.now()}-${randomUUID()}`;
  const nonceAppToTest = `sentinel-a2t-${Date.now()}-${randomUUID()}`;
  let operationError: unknown = null;

  try {
    // Direction 1: Test pool writes, Application pool reads
    await testPool.query(
      `INSERT INTO ${BRANCH_MARKER_SCHEMA}.sentinel (nonce, written_at) VALUES ($1, now())`,
      [nonceTestToApp],
    );
    const readApp = await viaApp.pool.query<{ nonce: string }>(
      `SELECT nonce FROM ${BRANCH_MARKER_SCHEMA}.sentinel WHERE nonce = $1`,
      [nonceTestToApp],
    );
    if (!readApp.rows[0] || readApp.rows[0].nonce !== nonceTestToApp) {
      throw new IntegrationIdentityError(
        "Application DB module could not read back sentinel written by test pool. Pools do NOT share a physical database.",
      );
    }

    // Direction 2: Application pool writes, Test pool reads
    await viaApp.pool.query(
      `INSERT INTO ${BRANCH_MARKER_SCHEMA}.sentinel (nonce, written_at) VALUES ($1, now())`,
      [nonceAppToTest],
    );
    const readTest = await testPool.query<{ nonce: string }>(
      `SELECT nonce FROM ${BRANCH_MARKER_SCHEMA}.sentinel WHERE nonce = $1`,
      [nonceAppToTest],
    );
    if (!readTest.rows[0] || readTest.rows[0].nonce !== nonceAppToTest) {
      throw new IntegrationIdentityError(
        "Test pool could not read back sentinel written by application DB module. Pools do NOT share a physical database.",
      );
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    for (const [label, pool] of [["test", testPool], ["application", viaApp.pool]] as const) {
      try {
        await pool.query(
          `DELETE FROM ${BRANCH_MARKER_SCHEMA}.sentinel WHERE nonce IN ($1, $2)`,
          [nonceTestToApp, nonceAppToTest],
        );
      } catch (error) {
        cleanupErrors.push(`${label} sentinel cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (cleanupErrors.length > 0) {
      const message = cleanupErrors.join("; ");
      if (operationError) {
        throw new Error(`${operationError instanceof Error ? operationError.message : String(operationError)}; ${message}`, {
          cause: operationError,
        });
      }
      throw new Error(message);
    }
  }
}
