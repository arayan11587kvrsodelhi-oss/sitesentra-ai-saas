/**
 * SiteSentra — provision the integration database.
 *
 * Creates the schema the tests need (idempotent) and writes the branch marker
 * that the identity gate reads. This script NEVER runs against the application
 * database: it uses the same fail-closed resolution as the test runner and
 * refuses to continue if `DATABASE_URL_INTEGRATION` is missing or points at
 * `DATABASE_URL`.
 *
 * Safety & Pre-condition Ordering:
 *   All connection, endpoint, database, operator confirmation, and existing-marker
 *   checks run BEFORE reading or executing schema SQL.
 *   If ANY marker already exists in ss_test_bootstrap.branch_marker, this script
 *   REFUSES to overwrite it.
 *
 * Branch verification limitation:
 *   PostgreSQL connections cannot independently query the Neon control plane
 *   to verify branch identity. Identity verification relies on endpoint-to-branch
 *   mapping and explicit operator confirmation.
 *   Therefore, provisioning requires explicit operator confirmation via
 *   `INTEGRATION_CONFIRM_BRANCH=true` or `--confirm-branch`.
 *
 * Usage:
 *   DATABASE_URL_INTEGRATION=... INTEGRATION_EXPECTED_ENDPOINT_ID=ep-... \
 *   INTEGRATION_EXPECTED_DATABASE_NAME=... INTEGRATION_EXPECTED_BRANCH=... \
 *   INTEGRATION_CONFIRM_BRANCH=true npm run test:integration:provision
 */
import { readFileSync } from "node:fs";
import { Pool } from "pg";

function fail(message) {
  console.error(`\n[provision] ABORTED: ${message}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL_INTEGRATION?.trim().replace(/^["']|["']$/g, "");
const appUrl = process.env.DATABASE_URL?.trim().replace(/^["']|["']$/g, "");
const expectedEndpoint = process.env.INTEGRATION_EXPECTED_ENDPOINT_ID?.trim().toLowerCase();
const expectedDatabase = process.env.INTEGRATION_EXPECTED_DATABASE_NAME?.trim();
const expectedBranch = process.env.INTEGRATION_EXPECTED_BRANCH?.trim();

if (!url) fail("DATABASE_URL_INTEGRATION is not set.");
if (!expectedEndpoint || !expectedDatabase || !expectedBranch) {
  fail("INTEGRATION_EXPECTED_ENDPOINT_ID, INTEGRATION_EXPECTED_DATABASE_NAME and INTEGRATION_EXPECTED_BRANCH must all be set.");
}

function extractEndpointId(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.toLowerCase().endsWith(".neon.tech")) {
      return null;
    }
    const firstLabel = parsed.hostname.split(".")[0]?.toLowerCase();
    if (!firstLabel || !firstLabel.startsWith("ep-")) {
      return null;
    }
    const endpoint = firstLabel.endsWith("-pooler")
      ? firstLabel.slice(0, -"-pooler".length)
      : firstLabel;
    if (!/^ep-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(endpoint)) {
      return null;
    }
    return endpoint;
  } catch {
    return null;
  }
}

function extractDatabaseName(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const db = parsed.pathname.replace(/^\/+/, "");
    return db.length > 0 ? db : null;
  } catch {
    return null;
  }
}

let parsedUrl;
try {
  parsedUrl = new URL(url);
} catch {
  fail("DATABASE_URL_INTEGRATION is not a parseable URL.");
}

const hostEndpoint = extractEndpointId(url);
if (!hostEndpoint) {
  fail("DATABASE_URL_INTEGRATION does not target a legitimate Neon hostname ending in .neon.tech.");
}
if (hostEndpoint !== expectedEndpoint) {
  fail(`Endpoint mismatch: URL targets '${hostEndpoint}', expected '${expectedEndpoint}'.`);
}

const targetDb = extractDatabaseName(url);
if (!targetDb || targetDb !== expectedDatabase) {
  fail(`Database mismatch: URL names '${targetDb}', expected '${expectedDatabase}'.`);
}

// Reject production target: compare raw strings AND parsed endpoint ID & database name.
// If DATABASE_URL is present but unparseable or not a postgres URL, abort rather than skipping production-collision detection.
if (appUrl) {
  if (appUrl === url) {
    fail("DATABASE_URL_INTEGRATION is identical to DATABASE_URL.");
  }
  let parsedApp;
  try {
    parsedApp = new URL(appUrl);
  } catch {
    fail("DATABASE_URL is present but is not a parseable URL. Production target cannot be safely evaluated; aborting.");
  }
  if (!/^postgres(ql)?:$/i.test(parsedApp.protocol)) {
    fail("DATABASE_URL is present but is not a valid postgres:// or postgresql:// URL. Production target cannot be safely evaluated; aborting.");
  }

  const appEndpoint = extractEndpointId(appUrl);
  const appDatabase = extractDatabaseName(appUrl);
  if (
    appEndpoint &&
    appDatabase &&
    hostEndpoint === appEndpoint &&
    targetDb === appDatabase
  ) {
    fail(
      `DATABASE_URL_INTEGRATION targets the same Neon endpoint ('${hostEndpoint}') and database ('${targetDb}') as DATABASE_URL. Refusing to provision against production.`,
    );
  }
}

// Check for explicit operator confirmation before making any database connection or modifications
const isConfirmed =
  process.env.INTEGRATION_CONFIRM_BRANCH?.trim().toLowerCase() === "true" ||
  process.argv.includes("--confirm-branch");

if (!isConfirmed) {
  fail(
    "Branch identity cannot be independently established from within an SQL session. " +
    "To guard against misdirected provisioning, set INTEGRATION_CONFIRM_BRANCH=true or pass --confirm-branch.",
  );
}

const pool = new Pool({ connectionString: url });

try {
  // Step 1: Live connection verification (database name check)
  const identity = await pool.query(
    "SELECT current_database() AS db, session_user::text AS usr, host(inet_server_addr()) AS addr",
  );
  if (identity.rows[0].db !== expectedDatabase) {
    fail(`Connected database is '${identity.rows[0].db}', expected '${expectedDatabase}'.`);
  }

  // Step 2: Check existing marker BEFORE reading or executing schema SQL.
  // Refuse to overwrite ANY existing marker.
  try {
    const existingMarker = await pool.query(
      "SELECT branch, database_name, endpoint_id FROM ss_test_bootstrap.branch_marker WHERE id = 1",
    );
    if (existingMarker.rows.length > 0) {
      const existing = existingMarker.rows[0];
      fail(
        `A branch marker already exists in ss_test_bootstrap.branch_marker ` +
        `(branch='${existing.branch}', db='${existing.database_name}', endpoint='${existing.endpoint_id}'). ` +
        `Provisioning refuses to overwrite any existing marker.`,
      );
    }
  } catch (markerErr) {
    // 42P01 is undefined_table; 3F000 is invalid_schema_name. Both indicate no marker table exists yet.
    if (
      markerErr.code !== "42P01" &&
      markerErr.code !== "3F000" &&
      !markerErr.message?.includes("does not exist")
    ) {
      throw markerErr;
    }
  }

  // Step 3: ONLY AFTER all connection, endpoint, database, and marker checks pass, execute schema SQL.
  const schemaSql = readFileSync(new URL("./integration-schema.sql", import.meta.url), "utf8");
  await pool.query(schemaSql);

  // Step 4: Write the confirmed branch marker.
  await pool.query(
    `INSERT INTO ss_test_bootstrap.branch_marker (id, branch, database_name, endpoint_id, written_at)
     VALUES (1, $1, $2, $3, now())`,
    [expectedBranch, expectedDatabase, expectedEndpoint],
  );

  console.log("[provision] ready");
  console.log(`  database ${identity.rows[0].db}`);
  console.log(`  user     ${identity.rows[0].usr}`);
  console.log(`  addr     ${identity.rows[0].addr ?? "n/a"}`);
  console.log(`  branch   ${expectedBranch} (operator-confirmed; not verifiable via SQL alone)`);
  console.log(`  endpoint ${expectedEndpoint}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await pool.end().catch(() => { });
}
