/**
 * SiteSentra — integration test entry point.
 *
 * Execution Model & Lifecycle:
 *   1. Resolve integration target fail-closed (no fallback to DATABASE_URL/.env).
 *   2. Point `process.env.DATABASE_URL` at it BEFORE any application module
 *      is loaded, ensuring `src/db/index.ts` connects to the verified database.
 *   3. Propagate and validate unique `INTEGRATION_RUN_ID`.
 *   4. Open test pool.
 *   5. Import and initialize the application DB module immediately so it connects
 *      to the target and is held in scope (preventing teardown from dynamically
 *      importing it and creating a new pool after shutdown).
 *   6. Verify live database identity for the test pool.
 *   7. Verify application and test pools connect to the exact same physical database
 *      via bidirectional sentinel write-and-read-back verification.
 *   8. Register verified pool in module state via `setIntegrationPool`.
 *   9. Register `after(...)` teardown hook strictly after both pools are verified.
 *  10. Import test suites in-process so they execute with verified pool state.
 *  11. On any setup failure, ensure created pools are closed and set process.exitCode = 1
 *      without calling process.exit().
 *
 * Run with:
 *   npm run test:integration
 */
import { Pool } from "pg";
import { pathToFileURL } from "node:url";

import {
  IntegrationConfigError,
  resolveIntegrationTarget,
  validateRunId,
  type IntegrationTarget,
} from "./integration-env.ts";
import {
  openVerifiedClient,
  assertSameDatabase,
  setIntegrationPool,
  clearIntegrationPool,
  type VerifiedIdentity,
} from "./integration-identity.ts";
import { RUN_ID } from "./integration-fixtures.ts";
import {
  createIntegrationLifecycleRegistration,
  failSetup,
  importIntegrationSuites,
} from "./runner-lifecycle.ts";

export type RunnerLifecycleOwner = {
  teardownRegistered: boolean;
};

export function createRunnerLifecycleOwner(): RunnerLifecycleOwner {
  return { teardownRegistered: false };
}

export function registerRunnerTeardown(
  testPool: Pool,
  appDb: { pool: Pick<Pool, "end"> },
  runId: string,
  owner: RunnerLifecycleOwner,
): () => void {
  if (!validateRunId(runId)) {
    throw new Error(
      `Invalid run ID format: '${runId}'. Expected format: ss-itest-<13-digits>-<8-hex-chars>.`,
    );
  }
  if (owner.teardownRegistered) {
    throw new Error("Runner teardown has already been registered.");
  }
  owner.teardownRegistered = true;
  const registerTeardown = createIntegrationLifecycleRegistration(
    testPool,
    appDb,
    runId,
  );
  registerTeardown();
  return registerTeardown;
}

export function registerVerifiedIntegrationLifecycle(
  testPool: Pool,
  appDb: { pool: Pick<Pool, "end"> },
  runId: string,
  owner: RunnerLifecycleOwner,
  setPool: (pool: Pool) => void = setIntegrationPool,
  clearPool: () => void = clearIntegrationPool,
): void {
  if (!validateRunId(runId)) {
    throw new Error(
      `Invalid run ID format: '${runId}'. Expected format: ss-itest-<13-digits>-<8-hex-chars>.`,
    );
  }
  if (owner.teardownRegistered) {
    throw new Error("Runner teardown has already been registered.");
  }
  try {
    setPool(testPool);
    registerRunnerTeardown(testPool, appDb, runId, owner);
  } catch (error) {
    try {
      clearPool();
    } catch (clearError) {
      throw new AggregateError(
        [error, clearError],
        "Integration lifecycle registration failed while clearing pool state.",
      );
    }
    throw error;
  }
}

let runStarted = false;

export async function run(): Promise<void> {
  if (runStarted) {
    process.exitCode = 1;
    throw new Error("Integration runner has already executed in this process.");
  }
  runStarted = true;
  // Validate RUN_ID format upfront
  if (!validateRunId(RUN_ID)) {
    console.error(`\n[integration] ABORTED: Invalid run ID '${RUN_ID}'.\n`);
    process.exitCode = 1;
    return;
  }
  process.env.INTEGRATION_RUN_ID = RUN_ID;

  let target: IntegrationTarget;
  try {
    target = resolveIntegrationTarget();
  } catch (error) {
    console.error(`\n[integration] ABORTED: ${error instanceof IntegrationConfigError ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  // Step 2: Repoint application environment BEFORE importing application code
  process.env.DATABASE_URL = target.url;

  // Step 4: Open test pool
  const testPool = new Pool({ connectionString: target.url });

  let appDb: typeof import("../src/db/index.ts") | null = null;
  try {
    // Step 5: Import and initialize application DB module upfront
    appDb = await import("../src/db/index.ts");
  } catch (appDbError) {
    await failSetup(appDbError, testPool, null);
  }
  const initializedAppDb = appDb ?? await failSetup(
    new Error("Application DB module was not initialized."),
    testPool,
    null,
  );

  // Step 6: Verify live database identity on test pool
  let identity: VerifiedIdentity | null = null;
  try {
    const verified = await openVerifiedClient(testPool, target);
    identity = verified.identity;
    verified.client.release();
  } catch (error) {
    await failSetup(error, testPool, appDb);
  }
  const verifiedIdentity = identity ?? await failSetup(
    new Error("Database identity was not verified."),
    testPool,
    initializedAppDb,
  );

  console.log("[integration] verified database identity:");
  console.log(`  database        ${verifiedIdentity.databaseName}`);
  console.log(`  endpoint        ${verifiedIdentity.endpointId}`);
  console.log(`  branch (marker) ${verifiedIdentity.branch} (operator-confirmed)`);
  console.log(`  session_user    ${verifiedIdentity.sessionUser}`);
  console.log(`  server address  ${verifiedIdentity.serverAddress ?? "n/a"}`);
  console.log(`  run_id          ${RUN_ID}`);

  // Step 7: Bidirectional sentinel verification between test pool and application pool
  try {
    await assertSameDatabase(testPool, target, initializedAppDb.pool);
    console.log("[integration] application db module and test pool share one database (bidirectional sentinel verified)");
  } catch (error) {
    await failSetup(error, testPool, initializedAppDb);
  }

  // Step 8: Register verified pool in module state for suites to import
  // Step 9: Register teardown hook strictly AFTER both pools are verified
  const lifecycleOwner = createRunnerLifecycleOwner();
  try {
    registerVerifiedIntegrationLifecycle(
      testPool,
      initializedAppDb,
      RUN_ID,
      lifecycleOwner,
    );
  } catch (error) {
    await failSetup(error, testPool, initializedAppDb);
  }

  // Step 10: Import suites in-process
  await importIntegrationSuites([
    () => import("./integration-auth.test.ts"),
    () => import("./integration-app.test.ts"),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
