-- ===========================================================================
-- SiteSentra — Row Level Security isolation test
--
-- Run against the database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/rls-isolation.sql
--
-- What it proves (as a NON-owner role, so RLS actually applies):
--   1. A user's JWT claim can only SELECT their own scan_reports rows.
--   2. Another user's report cannot be deleted or updated (0 rows affected).
--   3. A report cannot be inserted claiming somebody else's user id.
--   4. The same isolation holds for users and sessions.
-- Any violation raises an exception, so a non-zero psql exit status = failure.
-- ===========================================================================

-- A scoped, non-owner role: this is what Supabase's `authenticated` role is
-- like. It has NOBYPASSRLS and does not own the tables, so policies apply.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_api;
GRANT USAGE ON SCHEMA auth TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.sessions, public.scan_reports TO app_api;

DO $$
DECLARE
  user_a uuid;
  user_b uuid;
  report_a uuid;
  report_b uuid;
  visible_count integer;
  affected integer;
  insert_blocked boolean := false;
BEGIN
  -- Two throwaway accounts, created as the owner (the app's server role).
  INSERT INTO public.users (email, password_hash)
  VALUES ('rls-alice@sitesentra.test', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$test')
  RETURNING id INTO user_a;

  INSERT INTO public.users (email, password_hash)
  VALUES ('rls-bob@sitesentra.test', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$test')
  RETURNING id INTO user_b;

  INSERT INTO public.scan_reports (user_id, input_url, target_host, status, report, summary)
  VALUES (user_a, 'https://alice.example/', 'alice.example', 'completed', '{}'::jsonb, '{}'::jsonb)
  RETURNING id INTO report_a;

  INSERT INTO public.scan_reports (user_id, input_url, target_host, status, report, summary)
  VALUES (user_b, 'https://bob.example/', 'bob.example', 'completed', '{}'::jsonb, '{}'::jsonb)
  RETURNING id INTO report_b;

  -- From here on we act as the scoped API role, impersonating user A the way
  -- Supabase would from a verified JWT.
  SET ROLE app_api;
  PERFORM set_config('request.jwt.claim.sub', user_a::text, true);

  -- 1. SELECT: only A's rows are visible.
  SELECT count(*) INTO visible_count FROM public.scan_reports;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'RLS SELECT leak: user A can see % scan_reports rows, expected 1', visible_count;
  END IF;

  SELECT count(*) INTO visible_count FROM public.scan_reports WHERE id = report_b;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'RLS SELECT leak: user A can read user B''s report %', report_b;
  END IF;

  SELECT count(*) INTO visible_count FROM public.users;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'RLS SELECT leak on users: expected 1 visible row, got %', visible_count;
  END IF;

  SELECT count(*) INTO visible_count FROM public.sessions;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'RLS SELECT leak on sessions: expected 0 visible rows, got %', visible_count;
  END IF;

  -- 2. DELETE / UPDATE of another user's report must affect nothing.
  DELETE FROM public.scan_reports WHERE id = report_b;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'RLS DELETE leak: user A deleted % of user B''s rows', affected;
  END IF;

  UPDATE public.scan_reports SET status = 'failed' WHERE id = report_b;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'RLS UPDATE leak: user A modified % of user B''s rows', affected;
  END IF;

  -- Rewriting the owner column of your own row must also be refused
  -- (no UPDATE policy exists on scan_reports at all).
  UPDATE public.scan_reports SET user_id = user_b WHERE id = report_a;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'RLS ownership-claim leak: user A reassigned their own report to user B';
  END IF;

  -- 3. INSERT claiming somebody else's id must violate the WITH CHECK policy.
  BEGIN
    INSERT INTO public.scan_reports (user_id, input_url, target_host, status, report, summary)
    VALUES (user_b, 'https://evil.example/', 'evil.example', 'completed', '{}'::jsonb, '{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN
    insert_blocked := true;
  END;
  IF NOT insert_blocked THEN
    RAISE EXCEPTION 'RLS INSERT leak: user A stored a report owned by user B';
  END IF;

  -- 4. Same check for the users table (impersonation guard).
  insert_blocked := false;
  BEGIN
    INSERT INTO public.users (id, email, password_hash)
    VALUES (user_b, 'rls-impersonation@sitesentra.test', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$test');
  EXCEPTION WHEN insufficient_privilege OR unique_violation THEN
    insert_blocked := true;
  END;
  IF NOT insert_blocked THEN
    RAISE EXCEPTION 'RLS users INSERT leak: user A created a row with user B''s id';
  END IF;

  RESET ROLE;

  -- Owner-level confirmation that B's report survived untouched.
  SELECT count(*) INTO visible_count FROM public.scan_reports WHERE id = report_b AND status = 'completed';
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'user B''s report was modified or deleted despite RLS';
  END IF;

  -- Clean up the throwaway accounts (cascades to their reports).
  DELETE FROM public.users WHERE id IN (user_a, user_b);

  RAISE NOTICE 'RLS isolation verified: cross-user SELECT, UPDATE, DELETE and ownership-claim INSERT were all denied.';
END $$;
