/**
 * SiteSentra — abuse limits for the scanner.
 *
 * Two layers, because each catches a different problem:
 *  1. Durable per-user quota (Postgres): caps how many scans one account can
 *     start inside a sliding window. Survives restarts and serverless reuse.
 *  2. In-process concurrency caps (memory): prevents one account from holding
 *     several scans open at once and prevents the whole process from fanning
 *     out too many outbound requests.
 *
 * Known limitation (documented, not hidden): the in-memory layer is per
 * instance. On a multi-instance deployment the durable quota still applies, but
 * the concurrency cap is per instance rather than global. A shared store (for
 * example Postgres advisory locks or a cache) would be needed for a hard global
 * cap; we deliberately did not add one to avoid a new dependency for the MVP.
 */
import { and, eq, gt, sql } from "drizzle-orm";

import { db } from "@/db";
import { scanReports } from "@/db/schema";

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  retryAfterSeconds: number;
  windowMinutes: number;
};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function rateLimitWindowMinutes(): number {
  return intEnv("SCAN_RATE_LIMIT_WINDOW_MINUTES", 60);
}

export function rateLimitMax(): number {
  return intEnv("SCAN_RATE_LIMIT_MAX_PER_WINDOW", 12);
}

/** Durable sliding-window quota, counted from persisted scan rows. */
export async function checkScanRateLimit(userId: string): Promise<RateLimitDecision> {
  const windowMinutes = rateLimitWindowMinutes();
  const limit = rateLimitMax();
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  const rows = await db
    .select({
      used: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${scanReports.startedAt})`,
    })
    .from(scanReports)
    .where(and(eq(scanReports.userId, userId), gt(scanReports.startedAt, windowStart)));

  const used = Number(rows[0]?.used ?? 0);
  const oldest = rows[0]?.oldest ? new Date(rows[0].oldest).getTime() : Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMinutes * 60 * 1000 - Date.now()) / 1000));

  return {
    allowed: used < limit,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    retryAfterSeconds: used < limit ? 0 : retryAfterSeconds,
    windowMinutes,
  };
}

// --- in-process concurrency -------------------------------------------------

const MAX_CONCURRENT_SCANS_PER_USER = 1;
const MAX_CONCURRENT_SCANS_GLOBAL = 4;

const perUserInFlight = new Map<string, number>();
let globalInFlight = 0;

export type SlotResult = { ok: true } | { ok: false; reason: "user-busy" | "server-busy" };

export function acquireScanSlot(userId: string): SlotResult {
  const userCount = perUserInFlight.get(userId) ?? 0;
  if (userCount >= MAX_CONCURRENT_SCANS_PER_USER) return { ok: false, reason: "user-busy" };
  if (globalInFlight >= MAX_CONCURRENT_SCANS_GLOBAL) return { ok: false, reason: "server-busy" };
  perUserInFlight.set(userId, userCount + 1);
  globalInFlight += 1;
  return { ok: true };
}

export function releaseScanSlot(userId: string): void {
  const userCount = perUserInFlight.get(userId) ?? 0;
  if (userCount <= 1) perUserInFlight.delete(userId);
  else perUserInFlight.set(userId, userCount - 1);
  globalInFlight = Math.max(0, globalInFlight - 1);
}

export function currentLoad(): { globalInFlight: number; usersScanning: number } {
  return { globalInFlight, usersScanning: perUserInFlight.size };
}
