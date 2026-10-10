BEGIN;

ALTER TABLE release_verification_record
  DROP CONSTRAINT IF EXISTS release_verification_record_verification_kind_check;

ALTER TABLE release_verification_record
  ADD CONSTRAINT release_verification_record_verification_kind_check
  CHECK(verification_kind IN (
    'MIGRATIONS','TYPECHECK','TESTS','BUILD','SECURITY',
    'STABILITY','PERFORMANCE','INTEGRATION','BROWSER_SMOKE',
    'RESTORE','RECONCILIATION',
    'RUNTIME_RLS','BUSINESS_JOURNEYS','NOISY_NEIGHBOR'
  ));

CREATE OR REPLACE FUNCTION corebiz_assert_release_candidate_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_required text[] := ARRAY[
    'CORE:MIGRATIONS',
    'CORE:TYPECHECK',
    'CORE:TESTS',
    'CORE:BUILD',
    'CORE:SECURITY',
    'CORE:STABILITY',
    'CORE:PERFORMANCE',
    'CORE:RESTORE',
    'AUTH:RUNTIME_RLS',
    'API:INTEGRATION',
    'API:BUSINESS_JOURNEYS',
    'API:BROWSER_SMOKE',
    'CORE:NOISY_NEIGHBOR',
    'FINANCE:RECONCILIATION',
    'ACCOUNTING:RECONCILIATION',
    'WMS:RECONCILIATION'
  ];
  v_item text;
  v_component text;
  v_kind text;
  v_outcome text;
  v_executed_at timestamptz;
  v_evaluated_at timestamptz;
BEGIN
  IF NEW.status <> 'APPROVED'
     OR OLD.status IS NOT DISTINCT FROM NEW.status
  THEN
    RETURN NEW;
  END IF;

  IF COALESCE((NEW.verdict_snapshot->>'readyForApproval')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'release candidate approval blocked: verdict is not ready'
      USING ERRCODE='check_violation';
  END IF;

  BEGIN
    v_evaluated_at := (NEW.verdict_snapshot->>'evaluatedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    v_evaluated_at := NULL;
  END;

  IF v_evaluated_at IS NULL
     OR v_evaluated_at < now() - interval '4 hours'
  THEN
    RAISE EXCEPTION 'release candidate approval blocked: verdict is stale'
      USING ERRCODE='check_violation';
  END IF;

  FOREACH v_item IN ARRAY v_required
  LOOP
    v_component := split_part(v_item,':',1);
    v_kind := split_part(v_item,':',2);

    SELECT r.outcome,r.executed_at
    INTO v_outcome,v_executed_at
    FROM release_verification_record r
    WHERE r.tenant_id=NEW.tenant_id
      AND r.target_version=NEW.target_version
      AND r.component_code=v_component
      AND r.verification_kind=v_kind
    ORDER BY r.executed_at DESC
    LIMIT 1;

    IF v_outcome IS NULL THEN
      RAISE EXCEPTION
        'release candidate approval blocked: missing evidence %:%',
        v_component,v_kind
        USING ERRCODE='check_violation';
    END IF;

    IF v_outcome <> 'PASS' THEN
      RAISE EXCEPTION
        'release candidate approval blocked: evidence %:% is %',
        v_component,v_kind,v_outcome
        USING ERRCODE='check_violation';
    END IF;

    IF v_executed_at < now() - interval '7 days' THEN
      RAISE EXCEPTION
        'release candidate approval blocked: evidence %:% is stale',
        v_component,v_kind
        USING ERRCODE='check_violation';
    END IF;

    IF v_executed_at > v_evaluated_at THEN
      RAISE EXCEPTION
        'release candidate approval blocked: evidence changed after verdict %:%',
        v_component,v_kind
        USING ERRCODE='check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS release_candidate_approval_gate
  ON release_candidate;

CREATE TRIGGER release_candidate_approval_gate
BEFORE UPDATE OF status ON release_candidate
FOR EACH ROW
EXECUTE FUNCTION corebiz_assert_release_candidate_approval();

REVOKE ALL ON FUNCTION corebiz_assert_release_candidate_approval()
  FROM PUBLIC;

COMMIT;
