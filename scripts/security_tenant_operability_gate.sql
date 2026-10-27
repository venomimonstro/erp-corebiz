-- Runtime structural gate for the canonical tenant commercial lifecycle.
-- Run after all migrations on a disposable/staging database. This script is
-- read-only: it verifies fail-closed wiring without mutating customer data.
DO $$
DECLARE
  v_def text;
  v_name text;
  v_missing text[] := '{}';
  v_public_functions text[] := ARRAY[
    'corebiz_public_site_page',
    'corebiz_public_site_page_by_host',
    'corebiz_public_site_routes',
    'corebiz_public_site_routes_by_host',
    'corebiz_public_site_tracker'
  ];
  v_worker_functions text[] := ARRAY[
    'corebiz_claim_domain_event',
    'corebiz_claim_marketing_sync_job',
    'corebiz_claim_channel_sync_job',
    'corebiz_claim_stock_dirty',
    'corebiz_claim_stock_target',
    'corebiz_schedule_fbs_stock_poll',
    'corebiz_claim_offline_conversion_job',
    'corebiz_claim_offline_conversion_status_job'
  ];
BEGIN
  SELECT pg_catalog.pg_get_functiondef(p.oid)
  INTO v_def
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname='corebiz_tenant_is_operational'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid)='p_tenant_id uuid';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'BLOCKED: corebiz_tenant_is_operational(uuid) is missing';
  END IF;

  IF position('tenant_subscription' in v_def)=0
     OR position('SUSPENDED' in v_def)=0
     OR position('CANCELLED' in v_def)=0
     OR position('READ_ONLY' in v_def)=0
     OR position('current_period_end' in v_def)=0
     OR position('grace_until' in v_def)=0 THEN
    RAISE EXCEPTION 'BLOCKED: canonical tenant operability predicate is incomplete';
  END IF;

  IF has_function_privilege(
       'public',
       'public.corebiz_tenant_is_operational(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'BLOCKED: PUBLIC can execute tenant operability predicate';
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app'
  ) OR NOT has_function_privilege(
       'corebiz_app',
       'public.corebiz_tenant_is_operational(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'BLOCKED: corebiz_app cannot execute tenant operability predicate';
  END IF;

  FOR v_name IN SELECT unnest(v_public_functions || v_worker_functions)
  LOOP
    SELECT string_agg(pg_catalog.pg_get_functiondef(p.oid), E'\n')
    INTO v_def
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=v_name;

    IF v_def IS NULL
       OR position('corebiz_tenant_is_operational' in v_def)=0 THEN
      v_missing:=array_append(v_missing,v_name);
    END IF;
  END LOOP;

  IF cardinality(v_missing)>0 THEN
    RAISE EXCEPTION
      'BLOCKED: public/background functions bypass tenant operability: %',
      array_to_string(v_missing,', ');
  END IF;

  -- Recovery operations must remain possible while a workspace is read-only.
  SELECT string_agg(pg_catalog.pg_get_functiondef(p.oid), E'\n')
  INTO v_def
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN (
      'corebiz_claim_tenant_export_job',
      'corebiz_claim_commerce_reconciliation'
    );

  IF v_def IS NOT NULL
     AND position('corebiz_tenant_is_operational' in v_def)>0 THEN
    RAISE EXCEPTION
      'BLOCKED: recovery export/payment reconciliation was incorrectly disabled by commercial operability';
  END IF;

  RAISE NOTICE
    'PASS: tenant lifecycle gates public traffic and external workers while recovery/export remain available';
END;
$$;
