-- ===========================================================================
-- SiteSentra — PostgreSQL Security Audit Queries (PostgreSQL 15+)
-- ===========================================================================
-- Run these queries against a disposable database to verify the security model.

-- 1. ROLE AUDIT
SELECT
    rolname AS role_name,
    rolcanlogin AS can_login,
    roleinherit AS inherits_privileges,
    rolsuper AS is_superuser,
    rolbypassrls AS can_bypass_rls,
    rolcreaterole AS can_create_role,
    rolcreatedb AS can_create_db
FROM pg_roles
WHERE rolname IN ('sitesentra_login', 'sitesentra_app', 'bootstrap_owner', 'migration_admin', 'postgres');

-- 2. MEMBERSHIP
SELECT
    mem.rolname AS member_role,
    role.rolname AS member_of,
    role.rolinherit AS inherits
FROM pg_auth_members am
JOIN pg_roles mem ON am.member = mem.oid
JOIN pg_roles role ON am.roleid = role.oid
WHERE mem.rolname = 'sitesentra_login';

-- 3. TABLE OWNERSHIP
SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind = 'r' AND n.nspname = 'public';

-- 4. SEQUENCE OWNERSHIP (auto and internal dependencies)
SELECT n.nspname, tbl.relname AS table_name, col.attname AS column_name,
       seq.relname AS sequence_name, dep.deptype AS dep_type,
       CASE col.attidentity WHEN 'a' THEN 'identity' ELSE 'serial' END AS id_type
FROM pg_depend dep
JOIN pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
JOIN pg_class tbl ON tbl.oid = dep.refobjid
JOIN pg_namespace n ON seq.relnamespace = n.oid
JOIN pg_attribute col ON col.attrelid = tbl.oid AND col.attnum = dep.refobjsubid
WHERE dep.deptype IN ('a','i') AND n.nspname = 'public';

-- 5. EXISTING ACLs (NULL-safe)
SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner,
       CASE WHEN c.relacl IS NULL THEN 'NULL' ELSE 'HAS_ACL' END AS acl_status,
       ae.grantee, pg_get_userbyid(ae.grantee) AS grantee_name,
       ae.privilege_type, ae.is_grantable
FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
LEFT JOIN LATERAL aclexplode(c.relacl) AS ae ON true
WHERE c.relkind = 'r' AND n.nspname = 'public';

-- 6. DEFAULT ACLs
SELECT n.nspname, pg_get_userbyid(d.defaclrole) AS role,
       CASE d.defaclobjtype WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence' WHEN 'F' THEN 'function' END,
       ae.grantee, pg_get_userbyid(ae.grantee) AS grantee_name,
       ae.privilege_type, ae.is_grantable
FROM pg_default_acl d JOIN pg_namespace n ON d.defaclnamespace = n.oid
LEFT JOIN LATERAL aclexplode(d.defaclacl) AS ae ON true
WHERE d.defaclacl IS NOT NULL;

-- 7. SCHEMA PRIVILEGES
SELECT r.rolname, n.nspname,
       has_schema_privilege(r.rolname, n.nspname, 'CREATE') AS can_create,
       has_schema_privilege(r.rolname, n.nspname, 'USAGE') AS can_use
FROM pg_namespace n CROSS JOIN pg_roles r
WHERE n.nspname IN ('public','auth','bootstrap','maintenance')
  AND r.rolname IN ('sitesentra_login','sitesentra_app','bootstrap_owner');

-- 8. RLS STATUS
SELECT schemaname, tablename, rowsecurity, force_rowsecurity
FROM pg_tables WHERE schemaname = 'public';

-- 9. RLS POLICIES
SELECT schemaname, tablename, policyname, cmd,
       qual::text AS qualifier, with_check::text AS with_check,
       array_to_string(roles, ', ') AS roles_str
FROM pg_policies WHERE schemaname = 'public';

-- 10. SECURITY DEFINER FUNCTIONS (expanded ACL with PUBLIC detection)
-- When proacl is NULL, PostgreSQL uses acldefault('f', proowner) as the
-- effective ACL. For functions, the default includes EXECUTE for PUBLIC.
WITH expanded_acls AS (
    SELECT
        p.oid AS func_oid,
        n.nspname AS schema_name,
        p.proname AS function_name,
        pg_get_userbyid(p.proowner) AS owner,
        p.prosecdef AS is_security_definer,
        pg_get_function_arguments(p.oid) AS arguments,
        (SELECT v FROM unnest(p.proconfig) v WHERE v LIKE 'search_path=%') AS search_path,
        CASE WHEN p.proacl IS NULL THEN 'NULL' ELSE 'HAS_ACL' END AS acl_status,
        ae.grantee AS grantee_oid,
        pg_get_userbyid(ae.grantee) AS grantee_name,
        ae.privilege_type,
        ae.is_grantable,
        CASE WHEN ae.grantee = 0 THEN 'PUBLIC' WHEN ae.grantee IS NULL THEN 'NONE' ELSE 'ROLE' END AS grantee_kind
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    LEFT JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS ae ON true
    WHERE p.prosecdef = true
      AND n.nspname IN ('public','bootstrap','maintenance')
)
SELECT * FROM expanded_acls;

-- 10b. PUBLIC EXECUTE grants on SECURITY DEFINER functions
-- Flags functions where PUBLIC (grantee=0) has EXECUTE privilege,
-- including implicit grants from acldefault when proacl is NULL.
SELECT
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_get_userbyid(p.proowner) AS owner,
    CASE WHEN p.proacl IS NULL THEN 'IMPLICIT (acldefault)' ELSE 'EXPLICIT' END AS grant_origin,
    ae.privilege_type,
    '⚠ PUBLIC HAS ' || UPPER(ae.privilege_type) || ' on SECURITY DEFINER function' AS WARNING
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS ae ON true
WHERE p.prosecdef = true
  AND n.nspname IN ('public','bootstrap','maintenance')
  AND ae.grantee = 0
  AND ae.privilege_type = 'X';
