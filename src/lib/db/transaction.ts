/**
 * SiteSentra — transaction wrapper with role switching and connection safety.
 *
 * SECURITY MODEL:
 *  - This wrapper is the ONLY path that can operate under sitesentra_app role.
 *  - The identity GUC (request.jwt.claim.sub) is set transaction-local via
 *    set_config(..., true), so it resets on COMMIT or ROLLBACK.
 *  - The application TypeScript layer is the authoritative authenticator.
 *    Database functions trust the GUC only because TS verified the user first.
 *
 * CONNECTION LIFECYCLE (DRIZZLE + PG-POOL 3.14.0):
 *  - withSiteSentraTransaction: CALLER owns the PoolClient lifecycle.
 *    This wrapper NEVER calls client.release().
 *  - withSiteSentraTransactionDirect: WRAPPER owns the PoolClient lifecycle.
 *    It acquires at entry, releases exactly once at exit.
 *  - Drizzle's transaction() on PoolClient sets isPool=false → no acquire/release.
 *    We manage BEGIN/COMMIT/ROLLBACK manually.
 *  - On COMMIT failure, we attempt best-effort ROLLBACK then throw.
 *    The caller (or finally block) decides: release() or release(error).
 */
import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

export class TransactionError extends Error {
  readonly cleanupError?: Error;

  constructor(
    message: string,
    originalError: Error,
    cleanupError?: Error,
  ) {
    super(message);
    this.name = "TransactionError";
    this.cause = originalError;
    this.cleanupError = cleanupError;
  }
}

/**
 * Wrap a Drizzle instance in a transaction with role switching.
 *
 * LIFECYCLE: The CALLER provides AND releases the PoolClient.
 * This wrapper NEVER calls client.release().
 *
 * On setup failure, committed-state uncertainty, or rollback failure,
 * the wrapper throws TransactionError with details. The caller's finally
 * block then decides: release() for clean state, release(error) to discard.
 *
 * DRIZZLE BEHAVIOR: drizzle(client) where client is a PoolClient (not Pool)
 * creates a session with isPool=false. drizzle.transaction() therefore
 * does NOT call client.release() in its finally block. We manage
 * BEGIN/COMMIT/ROLLBACK manually and pass the Drizzle tx to the callback.
 */
export async function withSiteSentraTransaction<T>(
  drizzleDb: PgDatabase<any, any>,
  client: PoolClient,
  userId: string,
  fn: (tx: NodePgTransaction<any, any>) => Promise<T>,
): Promise<T> {
  // ---- BEGIN + ROLE SETUP ----
  try {
    await client.query("BEGIN");
    await client.query("SET ROLE sitesentra_app");
    await client.query(
      "SELECT set_config('request.jwt.claim.sub', $1, true)",
      [userId],
    );
  } catch (err) {
    const setupError = err instanceof Error ? err : new Error(String(err));
    // Best-effort cleanup: caller will decide release vs discard.
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore; caller handles the client.
    }
    throw new TransactionError(
      "Transaction setup failed: " + setupError.message,
      setupError,
    );
  }

  // drizzle(client) binds to this exact PoolClient; isPool=false so Drizzle
  // will NOT acquire or release the client in its transaction finally block.
  const txDb = drizzle(client);

  try {
    const result = await txDb.transaction(async (tx) => {
      return await fn(tx);
    });

    // ---- COMMIT ----
    try {
      await client.query("COMMIT");
    } catch (commitErr) {
      // COMMIT failed: transaction outcome UNKNOWN.
      // Best-effort rollback; caller decides release strategy.
      const ce =
        commitErr instanceof Error ? commitErr : new Error(String(commitErr));
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore; caller handles the client.
      }
      throw new TransactionError(
        "COMMIT failed — transaction outcome unknown: " + ce.message,
        ce,
      );
    }

    return result;
  } catch (err) {
    const primaryError = err instanceof Error ? err : new Error(String(err));

    // ---- ATTEMPT ROLLBACK ----
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      // ROLLBACK failed: connection state UNCERTAIN.
      const cleanupError =
        rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      throw new TransactionError(
        primaryError.message +
          " (rollback also failed: " +
          cleanupError.message +
          ")",
        primaryError,
        cleanupError,
      );
    }

    throw primaryError;
  }
}

/**
 * Direct wrapper that acquires and manages the full client lifecycle.
 * Recommended API for new code.
 *
 * LIFECYCLE: This wrapper calls pool.connect() and is responsible for
 * releasing the client exactly once via release() or release(error).
 */
export async function withSiteSentraTransactionDirect<T>(
  pool: Pool,
  userId: string,
  fn: (tx: NodePgTransaction<any, any>) => Promise<T>,
): Promise<T> {
  let client: PoolClient | null = null;
  let primaryError: Error | null = null;
  let cleanupError: Error | null = null;

  // ---- ACQUIRE ----
  try {
    client = await pool.connect();
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  try {
    // ---- BEGIN + ROLE SETUP ----
    try {
      await client.query("BEGIN");
      await client.query("SET ROLE sitesentra_app");
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true)",
        [userId],
      );
    } catch (err) {
      const setupError = err instanceof Error ? err : new Error(String(err));
      cleanupError = setupError;
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore
      }
      // Discard: wrapper owns this client and cannot return an uncertain one.
      client.release(setupError);
      client = null;
      throw new TransactionError(
        "Transaction setup failed: " + setupError.message,
        setupError,
        cleanupError,
      );
    }

    const txDb = drizzle(client!);

    try {
      // Use Drizzle's transaction for nested savepoint support.
      // isPool=false so Drizzle does NOT release client.
      const result = await txDb.transaction(async (tx) => {
        return await fn(tx);
      });

      // ---- COMMIT ----
      try {
        await client!.query("COMMIT");
      } catch (commitErr) {
        const ce =
          commitErr instanceof Error ? commitErr : new Error(String(commitErr));
        // COMMIT failed: UNKNOWN outcome. Discard regardless of ROLLBACK.
        try {
          await client!.query("ROLLBACK");
        } catch {
          // Ignore; already discarding.
        }
        client!.release(ce);
        client = null;
        throw new TransactionError(
          "COMMIT failed — transaction outcome unknown: " + ce.message,
          ce,
        );
      }

      // Success path: normal release.
      client!.release();
      client = null;
      return result;
    } catch (err) {
      primaryError = err instanceof Error ? err : new Error(String(err));

      // ---- ATTEMPT ROLLBACK ----
      try {
        await client!.query("ROLLBACK");
      } catch (rbErr) {
        cleanupError =
          rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        // ROLLBACK failed: connection state UNCERTAIN. Discard.
        client!.release(cleanupError);
        client = null;
        throw new TransactionError(
          primaryError.message +
            " (rollback also failed: " +
            cleanupError.message +
            ")",
          primaryError,
          cleanupError,
        );
      }

      // Rollback succeeded: safe to release normally.
      client!.release();
      client = null;
      throw primaryError;
    }
  } finally {
    // Failsafe: if wrapper still owns an unreleased client, discard it.
    if (client) {
      try {
        client.release(new Error("Unclean transaction exit"));
      } catch {
        // Already released or connection lost
      }
      client = null;
    }
  }
}
