-- ===========================================================================
-- SiteSentra — reproducible schema + Row Level Security
--
-- Two ways this file is used:
--   1. On Supabase: run it in the SQL editor (or via `supabase db push`) after
--      creating the project. It is the authoritative security layer for any
--      client that talks to PostgREST with an anon/authenticated JWT.
--   2. Locally: applied on top of `npx drizzle-kit push` so the RLS policies can
--      be verified with a non-owner role (see the verification block at the
--      bottom, and tests/rls-isolation.sql).
--
-- IMPORTANT, HONEST NOTE ABOUT WHO RLS ACTUALLY PROTECTS:
--   Row Level Security does not apply to the *owner* of a table unless
--   FORCE ROW LEVEL SECURITY is set. The Next.js server connects with the
--   privileged/owner role, so its queries are NOT restricted by these policies.
--   That is why every query in src/ also carries an explicit
--   `where user_id = <session user id>` predicate — see
--   src/app/api/scans/[id]/route.ts and src/app/dashboard/page.tsx.
--   We deliberately do NOT set FORCE ROW LEVEL SECURITY: the owner connection
--   has no JWT claim, so forcing RLS would make the application see zero rows.
--   These policies are the boundary for any *other* role (Supabase `anon`,
--   `authenticated`, or a scoped role you create), which is the situation where
--   RLS actually matters.
-- ===========================================================================

-- --- auth.uid() shim -------------------------------------------------------
-- Supabase provides auth.uid(). This block creates an equivalent only when it
-- does not already exist, so the same file runs on a plain PostgreSQL server.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'auth'
  ) THEN
    CREATE SCHEMA auth;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $fn$;
  END IF;
END
$$;

-- --- tables ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON public.users (email);

CREATE TABLE IF NOT EXISTS public.sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT sessions_expiry_in_future CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON public.sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON public.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON public.sessions (expires_at);

CREATE TABLE IF NOT EXISTS public.scan_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  input_url          text NOT NULL CONSTRAINT scan_reports_input_url_length CHECK (char_length(input_url) <= 2048),
  normalized_url     text,
  target_host        text,
  resolved_addresses jsonb,
  status             text NOT NULL CHECK (status IN ('completed','inconclusive','failed')),
  failure_code       text,
  failure_message    text,
  report             jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary            jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms        integer CONSTRAINT scan_reports_duration_not_negative CHECK (duration_ms IS NULL OR duration_ms >= 0),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz
);
CREATE INDEX IF NOT EXISTS scan_reports_user_started_idx ON public.scan_reports (user_id, started_at DESC);

-- --- Row Level Security ----------------------------------------------------
ALTER TABLE public.users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_reports ENABLE ROW LEVEL SECURITY;

-- Drop first so the file is idempotent.
DROP POLICY IF EXISTS users_select_own       ON public.users;
DROP POLICY IF EXISTS users_insert_self      ON public.users;
DROP POLICY IF EXISTS users_update_own       ON public.users;
DROP POLICY IF EXISTS sessions_select_own    ON public.sessions;
DROP POLICY IF EXISTS sessions_insert_own    ON public.sessions;
DROP POLICY IF EXISTS sessions_update_own    ON public.sessions;
DROP POLICY IF EXISTS reports_select_own     ON public.scan_reports;
DROP POLICY IF EXISTS reports_insert_own     ON public.scan_reports;
DROP POLICY IF EXISTS reports_delete_own     ON public.scan_reports;

-- users: a caller may read only their own row, and may only create a row whose
-- id is the id claimed by their token (no impersonation).
CREATE POLICY users_select_own ON public.users
  FOR SELECT USING (id = auth.uid());

CREATE POLICY users_insert_self ON public.users
  FOR INSERT WITH CHECK (id = auth.uid());

-- Deliberately narrow: last_login_at only. Email and password_hash are never
-- writable through the API, so a stolen token cannot re-point an account.
CREATE POLICY users_update_own ON public.users
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- sessions: the token hash is a secret, so sessions are never readable through
-- the public API. Ownership is enforced anyway for defence in depth.
CREATE POLICY sessions_select_own ON public.sessions
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY sessions_insert_own ON public.sessions
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY sessions_update_own ON public.sessions
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- scan_reports: the core isolation rule. Every operation is restricted to rows
-- owned by the authenticated user, and INSERT must claim the caller's own id.
CREATE POLICY reports_select_own ON public.scan_reports
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY reports_insert_own ON public.scan_reports
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY reports_delete_own ON public.scan_reports
  FOR DELETE USING (user_id = auth.uid());

-- No UPDATE policy on scan_reports: stored evidence is immutable. A report is
-- either yours to read/delete or it is not; it can never be edited in place.

-- --- verification ----------------------------------------------------------
-- Run this as a NON-owner role to prove isolation (see tests/rls-isolation.sql):
--
--   CREATE ROLE app_api NOLOGIN NOBYPASSRLS;
--   GRANT USAGE ON SCHEMA public TO app_api;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_api;
--   SET ROLE app_api;
--   SET request.jwt.claim.sub = '<uuid of user A>';
--   SELECT count(*) FROM public.scan_reports;          -- only A's rows
--   DELETE FROM public.scan_reports WHERE user_id <> '<uuid of user A>';  -- 0 rows
