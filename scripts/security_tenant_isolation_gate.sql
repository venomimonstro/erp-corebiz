-- Read-only production gate. Execute as the REAL runtime API role, never as
-- the migration/schema owner. Fails loudly when RLS can be bypassed.
-- Example: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/security_tenant_isolation_gate.sql
DO $$
DECLARE unsafe_role boolean;
DECLARE n_missing integer;
DECLARE n_owned integer;
DECLARE examples text;
BEGIN
 SELECT (rolsuper OR rolbypassrls) INTO unsafe_role
 FROM pg_catalog.pg_roles WHERE rolname=current_user;
 IF unsafe_role IS NULL OR unsafe_role THEN
   RAISE EXCEPTION 'SECURITY_FAIL: runtime DB role % has SUPERUSER/BYPASSRLS privilege',current_user;
 END IF;

 SELECT count(*),string_agg(c.relname,', ' ORDER BY c.relname)
 INTO n_missing,examples
 FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    AND a.attname='tenant_id' AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
 AND (
   NOT c.relrowsecurity OR NOT EXISTS(
     SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid
       AND p.polcmd='*' AND p.polqual IS NOT NULL
   )
 );
 IF n_missing>0 THEN
   RAISE EXCEPTION 'SECURITY_FAIL: % tenant tables lack enabled applicable RLS: %',
     n_missing,left(examples,1400);
 END IF;

 SELECT count(*),string_agg(c.relname,', ' ORDER BY c.relname)
 INTO n_owned,examples
 FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    AND a.attname='tenant_id' AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
   AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
   AND NOT c.relforcerowsecurity;
 IF n_owned>0 THEN
   RAISE EXCEPTION 'SECURITY_FAIL: runtime role owns % unforced tenant tables: %',
     n_owned,left(examples,1400);
 END IF;
 RAISE NOTICE 'SECURITY_PASS: runtime role %, tenant RLS enabled and no owner bypass',current_user;
END $$;

-- Review separately: SECURITY DEFINER routines callable by PUBLIC, including
-- inherited default privileges, require manual sign-off.
SELECT n.nspname,p.proname,p.oid::pg_catalog.regprocedure AS function_signature
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef
  AND has_function_privilege('PUBLIC',p.oid,'EXECUTE')
ORDER BY p.proname;
