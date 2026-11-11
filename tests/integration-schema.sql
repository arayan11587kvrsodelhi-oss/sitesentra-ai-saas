-- Integration-only schema. Applied solely to the database named by
-- DATABASE_URL_INTEGRATION, never to production (see provision-integration.mjs).
-- This is intentionally a test bootstrap, not a byte-for-byte copy of the
-- Drizzle migration or the Supabase/RLS schema. Differences are documented
-- below so provisioning cannot be mistaken for full schema fidelity.
--
-- Compared with drizzle/0000_lethal_zombie.sql + 0001_ordinary_romulus.sql:
--   * The migration creates the same three application tables, enum, foreign
--     keys, and final indexes. Its temporary
--     scan_reports_user_window_idx is created then dropped by 0001 and is not
--     present here.
--   * This file uses IF NOT EXISTS/DO guards for repeatable test provisioning.
--   * The migration does not create ss_test_bootstrap, its marker/sentinel/
--     fixture registry, or their index; this bootstrap deliberately does not
--     create an unused database-side fixture registry.
--
-- Compared with supabase/schema.sql:
--   * This file omits auth.uid(), RLS enablement, FORCE-RLS decisions, and all
--     users/sessions/scan_reports policies.
--   * Supabase adds sessions_expiry_in_future and scan_reports input-length and
--     non-negative-duration checks. It also declares scan status as text with a
--     CHECK rather than the migration's scan_status enum.
--   * Supabase specifies the scan index ordering as started_at DESC; the
--     Drizzle migration and this bootstrap use the default ascending order.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

DO $$
BEGIN
  IF to_regtype('public.scan_status') IS NULL THEN
    CREATE TYPE scan_status AS ENUM ('completed', 'inconclusive', 'failed');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS scan_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_url          text NOT NULL,
  normalized_url     text,
  target_host        text,
  resolved_addresses jsonb,
  status             scan_status NOT NULL,
  failure_code       text,
  failure_message    text,
  report             jsonb NOT NULL DEFAULT '{}',
  summary            jsonb NOT NULL DEFAULT '{}',
  duration_ms        integer,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz
);
CREATE INDEX IF NOT EXISTS scan_reports_user_started_idx ON scan_reports (user_id, started_at);

-- Branch identity marker and test coordination schema.
CREATE SCHEMA IF NOT EXISTS ss_test_bootstrap;

CREATE TABLE IF NOT EXISTS ss_test_bootstrap.branch_marker (
  id            integer PRIMARY KEY DEFAULT 1,
  branch        text NOT NULL,
  database_name text NOT NULL,
  endpoint_id   text NOT NULL,
  written_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branch_marker_single_row CHECK (id = 1)
);

-- Sentinel table to prove application and test pools connect to the same physical database.
CREATE TABLE IF NOT EXISTS ss_test_bootstrap.sentinel (
  nonce      text PRIMARY KEY,
  written_at timestamptz NOT NULL DEFAULT now()
);

-- Database-scoped fixture tracking table to guarantee cross-process cleanup visibility.
