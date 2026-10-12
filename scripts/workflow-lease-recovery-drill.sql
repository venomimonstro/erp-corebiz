\set ON_ERROR_STOP on
-- DISPOSABLE/STAGING ONLY. SQL transaction is rolled back, including claims.
-- Demonstrates 20-minute abandoned outbox lease recovery without re-running
-- a workflow action or contacting any external service.
BEGIN;
DO $$
DECLARE
  owner_tenant uuid;
  synthetic_id uuid;
  selected record;
  second_id uuid;
  actual_attempts integer;
  actual_status text;
BEGIN
  SELECT id INTO owner_tenant FROM tenant ORDER BY created_at LIMIT 1;
  IF owner_tenant IS NULL THEN
    RAISE EXCEPTION 'WORKFLOW_DRILL_REQUIRES_DISPOSABLE_TENANT';
  END IF;

  INSERT INTO domain_event_outbox(
    tenant_id,event_name,payload,depth,attempts,status,
    created_at,locked_at
  ) VALUES (
    owner_tenant,'COREBIZ_DISPOSABLE_WORKER_RECOVERY_DRILL',
    '{}'::jsonb,0,0,'PROCESSING',
    '1970-01-01 00:00:00+00',now()-interval '20 minutes'
  ) RETURNING id INTO synthetic_id;

  SELECT * INTO selected FROM public.corebiz_claim_domain_event();
  IF selected.id IS DISTINCT FROM synthetic_id THEN
    RAISE EXCEPTION 'WORKFLOW_LEASE_RECOVERY_FAILED';
  END IF;
  SELECT attempts,status INTO actual_attempts,actual_status
  FROM domain_event_outbox WHERE id=synthetic_id;
  IF actual_status<>'PROCESSING' OR actual_attempts<>1 OR
     selected.locked_at<now()-interval '1 minute' THEN
    RAISE EXCEPTION 'WORKFLOW_LEASE_RENEWAL_FAILED';
  END IF;

  SELECT id INTO second_id FROM public.corebiz_claim_domain_event();
  IF second_id=synthetic_id THEN
    RAISE EXCEPTION 'WORKFLOW_LEASE_DUPLICATE_CLAIM';
  END IF;
  RAISE NOTICE 'PASS: stale event reclaimed once, with new timestamp; all test writes roll back';
END $$;
ROLLBACK;
