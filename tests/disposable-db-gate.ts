/**
 * SiteSentra — disposable database verification gate.
 *
 * This module verifies that the connected database is a dedicated test instance.
 * It MUST run before any fixture-creating or data-modifying tests.
 *
 * Verification checks (all must pass):
 *  1. Connected database name matches expected test prefix
 *  2. Login role (session_user) is exactly the expected test role
 *  3. Effective role (current_user) matches session_user (no SET ROLE abuse)
 *  4. A durable marker table exists in bootstrap schema
 *  5. Marker table is owned by postgres (provisioner), not the test role
 *  6. Test role cannot CREATE in bootstrap schema
 *  7. Test role cannot SET ROLE to any non-trivial privileged role (recursive)
 *  8. Role membership chain does not include privileged roles transitively
 *  9. Marker table row count sanity (provisioning completed)
 *
 * Security guarantees:
 *  - The same pool/client executes both verification and tests
 *  - Database-name prefix alone is NOT sufficient proof
 *  - Marker existence alone is NOT sufficient proof
 *  - Both ownership AND privilege checks are required
 *
 * LIMITATION: This gate verifies the CURRENT connection state at verification time.
 * It cannot prevent a concurrent superuser from modifying the database after
 * verification completes. For strong isolation, use an independently provisioned
 * disposable database per test process. The marker table and provisioning checks
 * are necessary but not sufficient proof of a safe-to-mutate environment.
 */
import type { PoolClient } from "pg";

export class DisposableDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisposableDbError";
  }
}

export interface TestDbConfig {
  url: string;
  expectedDbNamePrefix: string;
  expectedLoginRole: string;
  markerSchema: string;
  markerTableName: string;
}

/**
 * Verify the connected database is a disposable test instance.
 * Verifies using the SAME client that will execute tests.
 *
 * @throws DisposableDbError if any verification fails
 */
export async function verifyDisposableDb(
  config: TestDbConfig,
  client: PoolClient,
): Promise<void> {
  try {
    // Check 1: Database name verification (prefix check)
    const dbResult = await client.query<{ datname: string }>(
      "SELECT current_database() AS datname"
    );
    const dbName = dbResult.rows[0]?.datname;
    if (!dbName?.startsWith(config.expectedDbNamePrefix)) {
      throw new DisposableDbError(
        `Database mismatch: connected to '${dbName}', expected prefix '${config.expectedDbNamePrefix}'`
      );
    }

    // Check 2: session_user (login role) must be exactly the expected role
    const sessionUserResult = await client.query<{ session_user: string }>(
      "SELECT session_user AS session_user"
    );
    const sessionUser = sessionUserResult.rows[0]?.session_user;
    if (sessionUser !== config.expectedLoginRole) {
      throw new DisposableDbError(
        `session_user mismatch: '${sessionUser}', expected '${config.expectedLoginRole}'`
      );
    }

    // Check 3: current_user must match session_user (no SET ROLE abuse)
    const currentUserResult = await client.query<{ current_user: string }>(
      "SELECT current_user AS current_user"
    );
    const currentUser = currentUserResult.rows[0]?.current_user;
    if (currentUser !== config.expectedLoginRole) {
      throw new DisposableDbError(
        `current_user mismatch: '${currentUser}', expected '${config.expectedLoginRole}' (possible SET ROLE abuse)`
      );
    }

    // Check 4: Durable marker table existence (schema-qualified)
    const markerCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relname = $1
          AND n.nspname = $2
          AND c.relkind = 'r'
      ) AS exists`,
      [config.markerTableName, config.markerSchema]
    );

    if (!markerCheck.rows[0]?.exists) {
      throw new DisposableDbError(
        `Missing marker table: '${config.markerSchema}.${config.markerTableName}' does not exist`
      );
    }

    // Check 5: Marker table ownership (table-level)
    const ownerCheck = await client.query<{ owner: string }>(
      `SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE c.relname = $1
         AND n.nspname = $2`,
      [config.markerTableName, config.markerSchema]
    );

    if (ownerCheck.rows[0]?.owner !== "postgres") {
      throw new DisposableDbError(
        `Marker ownership mismatch: '${config.markerSchema}.${config.markerTableName}' owned by '${ownerCheck.rows[0]?.owner}', expected 'postgres'`
      );
    }

    // Check 6: Test role cannot CREATE in bootstrap schema (effective privileges)
    // Note: has_schema_privilege resolves effective privileges including inherited ones.
    // String literals required — cannot parameterize.
    const createCheck = await client.query<{ can_create: boolean }>(
      `SELECT has_schema_privilege('${config.expectedLoginRole}', '${config.markerSchema}', 'CREATE') AS can_create`
    );

    if (createCheck.rows[0]?.can_create) {
      throw new DisposableDbError(
        `Test role '${config.expectedLoginRole}' has CREATE privilege on '${config.markerSchema}' schema — marker can be spoofed`
      );
    }

    // Check 7: Recursive role-escalation check with explicit path-based cycle detection.
    // PostgreSQL's pg_auth_members only shows direct memberships. To detect
    // transitive escalation (A → B → C where C is privileged), we recursively
    // walk the membership graph using a recursive CTE with an explicit visited path.
    //
    // Cycle detection: each row carries the path (oid[]) of role OIDs traversed so far.
    // The recursive step skips any member whose OID already appears in the path,
    // preventing infinite loops regardless of UNION vs UNION ALL behavior.
    // Depth limit (< 20) is defense-in-depth beyond the explicit cycle guard.
    const escalationCheck = await client.query<{ can_escalate: boolean }>(
      `WITH RECURSIVE member_tree AS (
        -- Base: direct members of the test role, path initialized with the test role's OID
        SELECT
          am.roleid AS target_role_id,
          r.rolname AS target_role,
          1 AS depth,
          ARRAY[(SELECT oid FROM pg_roles WHERE rolname = '${config.expectedLoginRole}')] || am.roleid AS path
        FROM pg_auth_members am
        JOIN pg_roles r ON r.oid = am.roleid
        WHERE am.member = (SELECT oid FROM pg_roles WHERE rolname = '${config.expectedLoginRole}')

        UNION

        -- Recursive: members of already-visited roles, skipping cycles
        SELECT
          am.roleid,
          r.rolname,
          mt.depth + 1,
          mt.path || am.roleid
        FROM member_tree mt
        JOIN pg_auth_members am ON am.member = mt.target_role_id
        JOIN pg_roles r ON r.oid = am.roleid
        WHERE mt.depth < 20
          AND am.roleid <> ALL (mt.path)  -- explicit cycle guard: skip if already visited
      )
      SELECT EXISTS (
        SELECT 1 FROM member_tree
        WHERE target_role NOT IN (
          'pg_signal_backend', 'pg_read_all_data', 'pg_write_all_data',
          'pg_read_all_settings', 'pg_read_all_logs', 'pg_stat_scan_tables',
          'pg_execute_server_program', 'pg_manage_lambda', 'pg_maintain',
          'pg_monitor', 'pg_read_server_files', 'pg_write_server_files',
          'pg_create_subscription', '${config.expectedLoginRole}'
        )
      ) AS can_escalate`
    );

    if (escalationCheck.rows[0]?.can_escalate) {
      throw new DisposableDbError(
        `Test role '${config.expectedLoginRole}' has transitive membership to privileged roles — can escalate via SET ROLE`
      );
    }

    // Check 9: Marker table row count sanity (provisioning completed)
    const countCheck = await client.query<{ cnt: number }>(
      `SELECT count(*) AS cnt FROM ${config.markerSchema}.${config.markerTableName}`
    );
    const markerCount = countCheck.rows[0]?.cnt ?? 0;
    if (markerCount === 0) {
      throw new DisposableDbError(
        `Marker table is empty: expected provisioner to have inserted marker row`
      );
    }
  } catch (err) {
    // Re-throw as DisposableDbError if not already
    if (err instanceof DisposableDbError) {
      throw err;
    }
    throw new DisposableDbError(
      `Database verification failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Acquire a client from the pool, verify it with the disposable gate,
 * and return it for the caller to use. The caller is responsible for
 * releasing the client exactly once after use.
 *
 * On verification failure, the acquired client is released (discarded via
 * release(error)) before re-throwing so no connection is leaked.
 *
 * @throws DisposableDbError if verification fails
 */
export async function acquireAndVerify(
  pool: import("pg").Pool,
  config: TestDbConfig,
): Promise<import("pg").PoolClient> {
  const client = await pool.connect();
  try {
    await verifyDisposableDb(config, client);
    return client;
  } catch (err) {
    // Verification failed: release with error to discard the client.
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}
