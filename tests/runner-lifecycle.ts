import { after } from "node:test";
import type { Pool } from "pg";

import { validateRunId } from "./integration-env.ts";
import { cleanupFixtures } from "./integration-fixtures.ts";

type CleanupPool = Pick<Pool, "query">;
type CloseablePool = Pick<Pool, "end">;
type AppDb = { pool: CloseablePool };

function contextualError(context: string, error: unknown): Error {
  return new Error(
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

function assertValidRunId(runId: string): void {
  if (!validateRunId(runId)) {
    throw new Error(
      `Invalid run ID format: '${runId}'. Expected format: ss-itest-<13-digits>-<8-hex-chars>.`,
    );
  }
}

export async function runIntegrationTeardown(
  testPool: CleanupPool & CloseablePool,
  appDb: AppDb,
  runId: string,
): Promise<void> {
  assertValidRunId(runId);
  const errors: Error[] = [];

  try {
    const result = await cleanupFixtures(testPool, runId);
    console.log(
      `[integration] cleanup removed sessions=${result.removed.sessions} scan_reports=${result.removed.scan_reports} users=${result.removed.users}`,
    );
  } catch (error) {
    errors.push(contextualError("Fixture cleanup failed", error));
    console.error("[integration] cleanup error:", error);
  }

  try {
    await testPool.end();
  } catch (error) {
    errors.push(contextualError("Test pool closure failed", error));
    console.error("[integration] test pool close failed:", error);
  }

  try {
    await appDb.pool.end();
  } catch (error) {
    errors.push(contextualError("Application pool closure failed", error));
    console.error("[integration] application pool close failed:", error);
  }

  if (errors.length > 0) {
    process.exitCode = 1;
    throw new AggregateError(errors, "Integration teardown failed.");
  }
}

export function createIntegrationLifecycleRegistration(
  testPool: CleanupPool & CloseablePool,
  appDb: AppDb,
  runId: string,
): () => void {
  assertValidRunId(runId);
  let registered = false;
  return () => {
    if (registered) {
      throw new Error("Integration teardown has already been registered.");
    }
    registered = true;
    after(() => runIntegrationTeardown(testPool, appDb, runId));
  };
}

export async function importIntegrationSuites(
  importers: Array<() => Promise<unknown>>,
): Promise<void> {
  try {
    for (const importer of importers) await importer();
  } catch (error) {
    process.exitCode = 1;
    throw error;
  }
}

export async function closePoolsAfterSetupFailure(
  testPool: CloseablePool,
  appDb: AppDb | null,
): Promise<void> {
  const errors: Error[] = [];
  try {
    await testPool.end();
  } catch (error) {
    errors.push(contextualError("Test pool closure after setup failure", error));
  }
  if (appDb) {
    try {
      await appDb.pool.end();
    } catch (error) {
      errors.push(contextualError("Application pool closure after setup failure", error));
    }
  }
  if (errors.length > 0) {
    process.exitCode = 1;
    throw new AggregateError(errors, "Integration setup cleanup failed.");
  }
}

export async function failSetup(
  setupError: unknown,
  testPool: CloseablePool,
  appDb: AppDb | null,
): Promise<never> {
  const errors: Error[] =
    setupError instanceof AggregateError
      ? setupError.errors.map((error) =>
          contextualError("Integration setup failed", error),
        )
      : [contextualError("Integration setup failed", setupError)];

  try {
    await closePoolsAfterSetupFailure(testPool, appDb);
  } catch (error) {
    if (error instanceof AggregateError) {
      errors.push(
        ...error.errors.map((item) =>
          contextualError("Setup pool cleanup failed", item),
        ),
      );
    } else {
      errors.push(contextualError("Setup pool cleanup failed", error));
    }
  }

  process.exitCode = 1;
  throw new AggregateError(errors, "Integration setup failed.");
}
