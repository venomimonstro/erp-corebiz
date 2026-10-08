-- Run this read-only diagnostic AS THE ACTUAL PRODUCTION API DATABASE ROLE.
-- Do not interpret any row count as proof of security without integration tests.
SELECT current_user AS connection_role,
       r.rolsuper AS is_superuser,
       r.rolbypassrls AS bypasses_rls,
       r.rolcanlogin AS can_login
FROM pg_roles r
WHERE r.rolname = current_user;

-- All public tables that carry a tenant_id but lack an enabled RLS policy.
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       pg_get_userbyid(c.relowner) AS table_owner,
       count(p.policyname)::integer AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=c.oid
  AND a.attname='tenant_id' AND NOT a.attisdropped
LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
WHERE c.relkind IN ('r','p') AND n.nspname='public'
GROUP BY n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner
HAVING NOT c.relrowsecurity OR count(p.policyname)=0
ORDER BY n.nspname,c.relname;

-- This query checks table ownership: ordinary table owners bypass RLS
-- unless FORCE ROW LEVEL SECURITY is enabled.
SELECT c.relname AS owned_tenant_table,
       c.relforcerowsecurity AS force_rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=c.oid
  AND a.attname='tenant_id' AND NOT a.attisdropped
WHERE n.nspname='public' AND c.relkind IN ('r','p')
  AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND NOT c.relforcerowsecurity
ORDER BY c.relname;
