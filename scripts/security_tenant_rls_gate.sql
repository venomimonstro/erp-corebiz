\set ON_ERROR_STOP on

-- Fail-closed database security gate for a disposable migrated database.
DO $$
DECLARE
  v_missing_rls text;
  v_missing_policy text;
  v_runtime record;
  v_owned text;
BEGIN
  SELECT string_agg(format('%I.%I',n.nspname,c.relname), ', ' ORDER BY c.relname)
  INTO v_missing_rls
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid=c.oid
   AND a.attname='tenant_id'
   AND NOT a.attisdropped
  WHERE n.nspname='public'
    AND c.relkind='r'
    AND NOT c.relrowsecurity;

  IF v_missing_rls IS NOT NULL THEN
    RAISE EXCEPTION 'Tenant tables without RLS: %', v_missing_rls;
  END IF;

  SELECT string_agg(format('%I.%I',n.nspname,c.relname), ', ' ORDER BY c.relname)
  INTO v_missing_policy
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid=c.oid
   AND a.attname='tenant_id'
   AND NOT a.attisdropped
  WHERE n.nspname='public'
    AND c.relkind='r'
    AND c.relrowsecurity
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy p
      WHERE p.polrelid=c.oid
    );

  IF v_missing_policy IS NOT NULL THEN
    RAISE EXCEPTION 'Tenant tables without RLS policy: %', v_missing_policy;
  END IF;

  SELECT
    r.rolname,
    r.rolsuper,
    r.rolbypassrls
  INTO v_runtime
  FROM pg_catalog.pg_roles r
  WHERE r.rolname='corebiz_app';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Runtime role corebiz_app is missing';
  END IF;

  IF v_runtime.rolsuper OR v_runtime.rolbypassrls THEN
    RAISE EXCEPTION
      'Runtime role corebiz_app must not be SUPERUSER/BYPASSRLS';
  END IF;

  SELECT string_agg(format('%I.%I',n.nspname,c.relname), ', ' ORDER BY c.relname)
  INTO v_owned
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid=c.oid
   AND a.attname='tenant_id'
   AND NOT a.attisdropped
  JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
  WHERE n.nspname='public'
    AND c.relkind='r'
    AND r.rolname='corebiz_app';

  IF v_owned IS NOT NULL THEN
    RAISE EXCEPTION
      'Runtime role corebiz_app owns tenant tables and could bypass RLS: %',
      v_owned;
  END IF;
END;
$$;

SELECT
  count(*)::integer AS tenant_tables_checked
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
JOIN pg_catalog.pg_attribute a
  ON a.attrelid=c.oid
 AND a.attname='tenant_id'
 AND NOT a.attisdropped
WHERE n.nspname='public'
  AND c.relkind='r';
