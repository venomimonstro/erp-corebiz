-- Execute using an administrative, read-only diagnostic session after
-- migrations (or as the actual corebiz_app role with catalog access).
-- Never issue GRANT/BYPASSRLS from this gate.
-- Any failed assertion raises an error, suitable for a manual release gate.
DO $$
DECLARE
  v_runtime_role oid;
  v_name text;
  v_function record;
  v_matched integer;
  v_missing text[] := '{}';
  v_open text[] := '{}';
  v_list text[] := ARRAY[
    'corebiz_auth_login_identity',
    'corebiz_auth_resolve_session',
    'corebiz_auth_memberships',
    'corebiz_auth_switch_tenant',
    'corebiz_auth_accept_invitation',
    'corebiz_public_site_page',
    'corebiz_public_site_page_by_host',
    'corebiz_public_site_routes',
    'corebiz_public_site_routes_by_host',
    'corebiz_public_site_tracker',
    'corebiz_resolve_public_storefront',
    'corebiz_resolve_public_cart',
    'corebiz_resolve_site_form_binding',
    'corebiz_resolve_tracker_site',
    'corebiz_tracker_summary',
    'corebiz_tracker_site_lookup',
    'corebiz_resolve_3pl_portal_access',
    'corebiz_resolve_channel_webhook',
    'corebiz_resolve_calltracking_connection'
  ];
BEGIN
  SELECT oid INTO v_runtime_role FROM pg_catalog.pg_roles
  WHERE rolname='corebiz_app';

  IF v_runtime_role IS NULL THEN
    RAISE EXCEPTION 'BLOCKED: corebiz_app runtime database role missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE oid=v_runtime_role AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'BLOCKED: runtime DB role is SUPERUSER or BYPASSRLS';
  END IF;

  FOR v_name IN SELECT unnest(v_list)
  LOOP
    SELECT count(*) INTO v_matched
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=v_name;

    IF v_matched=0 THEN
      v_missing:=array_append(v_missing,v_name||' (function absent)');
      CONTINUE;
    END IF;

    FOR v_function IN
      SELECT
        p.oid,
        p.oid::pg_catalog.regprocedure AS signature,
        p.prosecdef,
        p.proacl,
        p.proowner
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=v_name
    LOOP
      IF NOT has_function_privilege(
        'corebiz_app',v_function.oid,'EXECUTE'
      ) THEN
        v_missing:=array_append(
          v_missing,v_function.signature::text||' (no EXECUTE)'
        );
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          coalesce(
            v_function.proacl,
            pg_catalog.acldefault('f',v_function.proowner)
          )
        ) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) THEN
        v_open:=array_append(v_open,v_function.signature::text);
      END IF;
    END LOOP;
  END LOOP;

  IF cardinality(v_missing)>0 THEN
    RAISE EXCEPTION 'BLOCKED: missing runtime function grants or migrations: %',
      array_to_string(v_missing,', ');
  END IF;

  IF cardinality(v_open)>0 THEN
    RAISE EXCEPTION 'BLOCKED: PUBLIC EXECUTE on sensitive functions: %',
      array_to_string(v_open,', ');
  END IF;

  RAISE NOTICE 'PASS: required runtime functions have explicit EXECUTE; PUBLIC is denied; app role cannot BYPASSRLS';
END;
$$;
