/**
 * SiteSentra — database schema (Drizzle ORM / PostgreSQL).
 *
 * Design rules applied here:
 *  - Only the tables the MVP actually needs: users, sessions, scan_reports.
 *  - We store as little personal data as possible: an email address and a
 *    password *hash*. No names, no IPs on the user record, no raw cookies.
 *  - Passwords are never stored in plaintext (scrypt hash, see src/lib/auth/password.ts).
 *  - Session tokens are stored only as SHA-256 hashes, so a database leak does
 *    not hand an attacker usable session cookies.
 *  - Scan evidence never stores Set-Cookie *values* (they can be session
 *    secrets). We store cookie names and their security flags only.
 *
 * Row Level Security for these tables lives in `supabase/schema.sql` so the same
 * schema can be reproduced on Supabase Postgres with RLS + policies enabled.
 */
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Always stored lower-cased so lookups are deterministic.
    email: text("email").notNull(),
    // Format: scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256 hex digest of the opaque bearer token that lives in the cookie.
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_key").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Terminal state of a scan.
 *  - completed  : we reached the target and observed real HTTP responses
 *  - failed     : the target could not be observed (refused, blocked, timeout…)
 *  - inconclusive: we connected, but not enough was observable to assess
 * A failed scan is NEVER presented as a passing security assessment.
 */
export const scanStatusEnum = pgEnum("scan_status", [
  "completed",
  "inconclusive",
  "failed",
]);

export const scanReports = pgTable(
  "scan_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Ownership. Every read/write path derives this from the authenticated
    // session — never from a client-supplied user id.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Exactly what the user typed (already sanitised/length-capped).
    inputUrl: text("input_url").notNull(),
    // Canonical target actually probed, with credentials and fragments removed.
    normalizedUrl: text("normalized_url"),
    targetHost: text("target_host"),
    // IP addresses we actually connected to, after SSRF validation.
    resolvedAddresses: jsonb("resolved_addresses").$type<string[]>(),
    status: scanStatusEnum("status").notNull(),
    // Machine-readable failure reason (e.g. "private-ip-blocked"). Safe to show.
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    /** Full structured result: { findings: Finding[], summary, meta, redirectChain, tls } */
    report: jsonb("report").notNull().$type<Record<string, unknown>>().default({}),
    /** Denormalised counters used by the history list: { pass, fail, warn, info, na, inconclusive } */
    summary: jsonb("summary").notNull().$type<Record<string, number>>().default({}),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // History is always "my scans, newest first" — this index serves it.
    index("scan_reports_user_started_idx").on(table.userId, table.startedAt),
    // Rate limiting counts scans per user inside a time window.
    index("scan_reports_user_window_idx").on(table.userId, table.startedAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ScanReport = typeof scanReports.$inferSelect;
export type ScanStatus = "completed" | "inconclusive" | "failed";
