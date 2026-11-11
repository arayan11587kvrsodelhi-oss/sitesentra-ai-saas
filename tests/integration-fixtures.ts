/**
 * SiteSentra — integration fixture tracking.
 *
 * Every row the test suite creates is registered here by primary key and
 * run ID, and teardown deletes *only* those keys. There is no unqualified
 * `DELETE FROM <table>` anywhere: a test that fails halfway, or a branch that
 * holds rows from an earlier run, can never be wiped by cleanup.
 *
 * Deletion order is strictly child → parent:
 *   1. `sessions`
 *   2. `scan_reports`
 *   3. `users`
 *
 * Safety & Accounting Guarantees:
 *  - Run IDs must strictly conform to `ss-itest-<13 digits>-<8 hex chars>`.
 *  - Journal write failures are fatal before any fixture is considered registered.
 *  - Journal read/parse failures are fatal during fixture resolution.
 *  - All SQL parameters, including run IDs, are strictly parameterized ($1, $2, ...).
 *  - If child fixture discovery or deletion fails, parent users are NOT deleted.
 *  - Unresolved fixture IDs and durable journal records are preserved on any failure.
 *  - Interpolated table names are strictly restricted to an allowlist.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { generateRunId, validateRunId } from "./integration-env.ts";

function resolveInitialRunId(): string {
  const envId = process.env.INTEGRATION_RUN_ID?.trim();
  if (envId) {
    if (!validateRunId(envId)) {
      throw new Error(
        `Invalid INTEGRATION_RUN_ID format: '${envId}'. Expected format: ss-itest-<13-digits>-<8-hex-chars>.`,
      );
    }
    return envId;
  }
  const generated = generateRunId();
  process.env.INTEGRATION_RUN_ID = generated;
  return generated;
}

/** Unique per run, validated against RUN_ID_PATTERN. */
export let RUN_ID = resolveInitialRunId();

export function setRunId(id: string): void {
  if (!validateRunId(id)) {
    throw new Error(
      `Invalid run ID format: '${id}'. Expected format: ss-itest-<13-digits>-<8-hex-chars>.`,
    );
  }
  RUN_ID = id;
  process.env.INTEGRATION_RUN_ID = id;
  const next = getRegistry(id);
  bindCurrentRegistry(next);
}

export function getRunId(): string {
  return RUN_ID;
}

export function fixtureEmail(label: string): string {
  return `${RUN_ID}-${label}@example.com`;
}

export type Registry = {
  userIds: Set<string>;
  sessionIds: Set<string>;
  reportIds: Set<string>;
};

/** In-memory registry for fast in-process tracking. */
export const registry: Registry = {
  userIds: new Set(),
  sessionIds: new Set(),
  reportIds: new Set(),
};

const registries = new Map<string, Registry>([[RUN_ID, registry]]);

function createRegistry(): Registry {
  return { userIds: new Set(), sessionIds: new Set(), reportIds: new Set() };
}

function assertValidRunId(runId: string): void {
  if (!validateRunId(runId)) {
    throw new Error(
      `Invalid run ID format: '${runId}'. Expected format: ss-itest-<13-digits>-<8-hex-chars>.`,
    );
  }
}

function getRegistry(runId: string): Registry {
  const existing = registries.get(runId);
  if (existing) return existing;
  const created = createRegistry();
  registries.set(runId, created);
  return created;
}

export function getRunRegistry(runId: string): Registry {
  assertValidRunId(runId);
  return getRegistry(runId);
}

function bindCurrentRegistry(next: Registry): void {
  registry.userIds = next.userIds;
  registry.sessionIds = next.sessionIds;
  registry.reportIds = next.reportIds;
}

/** Fixed allowlist of table names permitted in fixture deletion. */
export const ALLOWED_FIXTURE_TABLES = [
  "sessions",
  "scan_reports",
  "users",
] as const;

export type AllowedFixtureTable = (typeof ALLOWED_FIXTURE_TABLES)[number];

export function getJournalPath(runId: string = RUN_ID): string {
  assertValidRunId(runId);
  return join(tmpdir(), `sitesentra-fixtures-${runId}.jsonl`);
}

/**
 * Append an entry to the run journal.
 * FATAL: Any journal write failure throws immediately so an unpersisted fixture
 * is never recorded in memory as successfully registered.
 */
function appendToJournal(entityType: "users" | "sessions" | "scan_reports", id: string): void {
  const journalPath = getJournalPath(RUN_ID);
  appendFileSync(journalPath, JSON.stringify({ runId: RUN_ID, entityType, id }) + "\n", "utf8");
}

export function trackUser(id: string): string {
  appendToJournal("users", id);
  getRegistry(RUN_ID).userIds.add(id);
  return id;
}

export function trackSession(id: string): string {
  appendToJournal("sessions", id);
  getRegistry(RUN_ID).sessionIds.add(id);
  return id;
}

export function trackReport(id: string): string {
  appendToJournal("scan_reports", id);
  getRegistry(RUN_ID).reportIds.add(id);
  return id;
}

/**
 * Load fixtures tracked across processes under the specified runId.
 * FATAL: Does not silently ignore file read or JSON parse failures.
 */
export function loadCrossProcessFixtures(runId: string = RUN_ID): void {
  assertValidRunId(runId);
  const loaded = loadJournalFixtures(runId);
  if (runId !== RUN_ID) return;
  const current = getRegistry(runId);
  for (const id of loaded.userIds) current.userIds.add(id);
  for (const id of loaded.sessionIds) current.sessionIds.add(id);
  for (const id of loaded.reportIds) current.reportIds.add(id);
}

function loadJournalFixtures(runId: string): Registry {
  const loaded: Registry = { userIds: new Set(), sessionIds: new Set(), reportIds: new Set() };
  const journalPath = getJournalPath(runId);
  if (!existsSync(journalPath)) return loaded;

  const raw = readFileSync(journalPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    let item: { runId?: string; entityType?: string; id?: string };
    try {
      item = JSON.parse(lines[i]);
    } catch (parseErr) {
      throw new Error(
        `Failed to parse fixture journal at line ${i + 1}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
    }
    if (item.runId !== runId || !item.id) continue;
    if (item.entityType === "users") loaded.userIds.add(item.id);
    else if (item.entityType === "sessions") loaded.sessionIds.add(item.id);
    else if (item.entityType === "scan_reports") loaded.reportIds.add(item.id);
    else {
      throw new Error(`Unknown fixture entity type '${item.entityType}' at line ${i + 1}.`);
    }
  }
  return loaded;
}

export type DeleteIdsResult = {
  deleted: string[];
  absent: string[];
  failed: string[];
};

export async function deleteIds(
  pool: Pick<Pool, "query">,
  table: string,
  ids: string[],
): Promise<DeleteIdsResult> {
  if (!ALLOWED_FIXTURE_TABLES.includes(table as AllowedFixtureTable)) {
    throw new Error(
      `Table '${table}' is not in the allowed fixture tables list: ${ALLOWED_FIXTURE_TABLES.join(", ")}`,
    );
  }
  if (ids.length === 0) return { deleted: [], absent: [], failed: [] };

  const deleted: string[] = [];
  const absent: string[] = [];
  const failed: string[] = [];
  const chunkSize = 100;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(", ");
    try {
      const result = await pool.query<{ id: string }>(
        `DELETE FROM ${table} WHERE id IN (${placeholders}) RETURNING id`,
        chunk,
      );
      const returnedIds = new Set(result.rows.map((r) => r.id));
      for (const id of chunk) {
        if (returnedIds.has(id)) {
          deleted.push(id);
        } else {
          absent.push(id);
        }
      }
    } catch {
      failed.push(...chunk);
    }
  }

  return { deleted, absent, failed };
}

export type CleanupResult = {
  removed: Record<string, number>;
  absent: Record<string, number>;
  failed: Record<string, string[]>;
};

/**
 * Remove every registered fixture for this run.
 *
 * Safe and idempotent:
 *  - Ingests cross-process fixtures and queries database-scoped run users.
 *  - If child discovery fails, parent users are preserved (never deleted).
 *  - Enforces child-first deletion: sessions -> scan_reports -> users.
 *  - Preserves failed IDs in registry and durable journal on any error.
 *  - Parameterizes all queries.
 */
export async function cleanupFixtures(
  pool: Pick<Pool, "query">,
  runId: string = RUN_ID,
): Promise<CleanupResult> {
  assertValidRunId(runId);
  const removed: Record<string, number> = { sessions: 0, scan_reports: 0, users: 0 };
  const absent: Record<string, number> = { sessions: 0, scan_reports: 0, users: 0 };
  const failed: Record<string, string[]> = { sessions: [], scan_reports: [], users: [] };
  const errors: string[] = [];
  let discovered: Registry;
  try {
    const journal = loadJournalFixtures(runId);
    const tracked = getRegistry(runId);
    discovered = {
      userIds: new Set(journal.userIds),
      sessionIds: new Set(journal.sessionIds),
      reportIds: new Set(journal.reportIds),
    };
    for (const id of tracked.userIds) discovered.userIds.add(id);
    for (const id of tracked.sessionIds) discovered.sessionIds.add(id);
    for (const id of tracked.reportIds) discovered.reportIds.add(id);
    const userPattern = `${runId}-%`;
    const runUsers = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email LIKE $1`,
      [userPattern],
    );
    for (const row of runUsers.rows) discovered.userIds.add(row.id);

    const userIds = [...discovered.userIds];
    if (userIds.length > 0) {
      const placeholders = userIds.map((_, i) => `$${i + 1}`).join(", ");
      const orphanSessions = await pool.query<{ id: string }>(
        `SELECT id FROM sessions WHERE user_id IN (${placeholders})`,
        userIds,
      );
      for (const row of orphanSessions.rows) discovered.sessionIds.add(row.id);

      const orphanReports = await pool.query<{ id: string }>(
        `SELECT id FROM scan_reports WHERE user_id IN (${placeholders})`,
        userIds,
      );
      for (const row of orphanReports.rows) discovered.reportIds.add(row.id);
    }
  } catch (error) {
    throw new Error(
      `Fixture discovery failed; no rows were deleted: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // Deletion begins only after every discovery step succeeds.
  const runRegistry = getRegistry(runId);
  runRegistry.userIds = discovered.userIds;
  runRegistry.sessionIds = discovered.sessionIds;
  runRegistry.reportIds = discovered.reportIds;
  if (runId === RUN_ID) bindCurrentRegistry(runRegistry);

  // Step 4a: Delete child fixtures first (sessions and scan_reports)
  for (const [key, table, set] of [
    ["sessions", "sessions", runRegistry.sessionIds],
    ["scan_reports", "scan_reports", runRegistry.reportIds],
  ] as const) {
    const ids = [...set];
    if (ids.length === 0) continue;

    const { deleted, absent: stepAbsent, failed: stepFailed } = await deleteIds(pool, table, ids);
    removed[key] = deleted.length;
    absent[key] = stepAbsent.length;

    for (const id of deleted) set.delete(id);
    for (const id of stepAbsent) set.delete(id);

    if (stepFailed.length > 0) {
      failed[key] = stepFailed;
      errors.push(`Failed to delete ${stepFailed.length} row(s) from ${table}: [${stepFailed.join(", ")}]`);
    }
  }

  // Step 4b: Delete parent users only when child deletion succeeded.
  if (Object.values(failed).every((ids) => ids.length === 0)) {
    const userIdsToDelete = [...runRegistry.userIds];
    if (userIdsToDelete.length > 0) {
      const { deleted, absent: stepAbsent, failed: stepFailed } = await deleteIds(
        pool,
        "users",
        userIdsToDelete,
      );
      removed.users = deleted.length;
      absent.users = stepAbsent.length;

      for (const id of deleted) runRegistry.userIds.delete(id);
      for (const id of stepAbsent) runRegistry.userIds.delete(id);

      if (stepFailed.length > 0) {
        failed.users = stepFailed;
        errors.push(`Failed to delete ${stepFailed.length} user(s): [${stepFailed.join(", ")}]`);
      }
    }
  } else {
    failed.users = [...runRegistry.userIds];
    errors.push("Skipped parent user deletion because child deletion failed.");
  }

  // Step 5: On failure, preserve durable journal with remaining unresolved IDs
  if (errors.length > 0) {
    try {
      const journalPath = getJournalPath(runId);
      const remainingLines: string[] = [];
      for (const id of runRegistry.sessionIds) {
        remainingLines.push(JSON.stringify({ runId, entityType: "sessions", id }));
      }
      for (const id of runRegistry.reportIds) {
        remainingLines.push(JSON.stringify({ runId, entityType: "scan_reports", id }));
      }
      for (const id of runRegistry.userIds) {
        remainingLines.push(JSON.stringify({ runId, entityType: "users", id }));
      }
      writeFileSync(journalPath, remainingLines.join("\n") + (remainingLines.length > 0 ? "\n" : ""), "utf8");
    } catch (error) {
      errors.push(`Recovery journal write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error(`Fixture cleanup failed: ${errors.join("; ")}`);
  }

  // Step 7: Clean up journal file on complete success
  try {
    const journalPath = getJournalPath(runId);
    if (existsSync(journalPath)) unlinkSync(journalPath);
  } catch (error) {
    throw new Error(
      `Fixture cleanup failed: Journal removal failed; recovery journal remains at ${getJournalPath(runId)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return { removed, absent, failed };
}
