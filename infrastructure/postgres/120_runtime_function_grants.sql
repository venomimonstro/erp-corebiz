BEGIN;

-- Runtime role is deliberately distinct from the schema owner / migration role.
-- Older SECURITY DEFINER functions revoked PUBLIC EXECUTE but did not grant
-- EXECUTE to the non-owner app role. Repair only explicitly reviewed API entrypoints.
-- The guard at scripts/security_runtime_function_gate.sql verifies the outcome.
DO $$
DECLARE
  v_role oid;
  v_function record;
  v_name text;
  v_whitelist text[] := ARRAY[
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
    'corebiz_resolve_calltracking_connection',
    'corebiz_wms_receive_unassigned'
  ];
BEGIN
  SELECT oid INTO v_role FROM pg_catalog.pg_roles WHERE rolname='corebiz_app';
  IF v_role IS NULL THEN
    RAISE WARNING
      'corebiz_app not found: grants not installed. Create a non-owner NOBYPASSRLS role and run reviewed role grant remediation before serving traffic';
    RETURN;
  END IF;

  FOR v_name IN SELECT unnest(v_whitelist)
  LOOP
    -- Functions may have different signatures; use catalog signatures, never
    -- interpolated input or a schema-wide GRANT EXECUTE.
    FOR v_function IN
      SELECT
        p.oid,
        p.oid::pg_catalog.regprocedure AS signature,
        p.prosecdef
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname=v_name
    LOOP
      -- Restrict to SECURITY DEFINER functions that explicitly need the
      -- specialized cross-tenant/public-key lookup. Ordinary SQL runs under
      -- tenant-aware RLS and is not granted elevated rights here.
      IF NOT v_function.prosecdef THEN
        CONTINUE;
      END IF;

      -- Fail closed even if a historical migration left EXECUTE open to PUBLIC.
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',v_function.signature);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO corebiz_app',v_function.signature);
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
