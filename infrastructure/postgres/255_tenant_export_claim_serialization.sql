BEGIN;

-- Migration 254 introduced an active-export unique index. Older FAILED jobs
-- can coexist with a newer PENDING job. The original claim function might
-- pick the FAILED job first and violate that index. Serialize claims per tenant
-- and always give the already queued export priority.
CREATE OR REPLACE FUNCTION corebiz_claim_tenant_export_job()
RETURNS TABLE(
  job_id uuid,
  tenant_id uuid,
  requested_by_membership_id uuid,
  format text,
  schema_version text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job tenant_export_job%ROWTYPE;
BEGIN
  SELECT j.* INTO v_job
  FROM tenant_export_job j
  WHERE (
    j.status IN ('PENDING','FAILED')
    OR (j.status='PROCESSING'
        AND j.lease_until IS NOT NULL
        AND j.lease_until <= now())
  )
  AND j.attempts < 5
  AND NOT EXISTS (
    SELECT 1 FROM tenant_export_job active
    WHERE active.tenant_id=j.tenant_id
      AND active.id<>j.id
      AND active.status IN ('PENDING','PROCESSING')
  )
  ORDER BY CASE WHEN j.status='PENDING' THEN 0 ELSE 1 END,
           j.created_at,j.id
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  -- Two workers may claim different FAILED jobs of the same tenant.
  -- A tenant row lock ensures only one becomes PROCESSING.
  PERFORM 1 FROM tenant
  WHERE id=v_job.tenant_id
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM tenant_export_job active
    WHERE active.tenant_id=v_job.tenant_id
      AND active.id<>v_job.id
      AND active.status IN ('PENDING','PROCESSING')
  ) THEN
    RETURN;
  END IF;

  UPDATE tenant_export_job
  SET status='PROCESSING',
      attempts=attempts+1,
      lease_until=now()+interval '15 minutes',
      started_at=COALESCE(started_at,now()),
      last_error=NULL,
      updated_at=now()
  WHERE id=v_job.id
    AND (
      status IN ('PENDING','FAILED')
      OR (status='PROCESSING'
          AND lease_until IS NOT NULL
          AND lease_until <= now())
    )
  RETURNING * INTO v_job;

  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT
    v_job.id,v_job.tenant_id,v_job.requested_by_membership_id,
    v_job.format,v_job.schema_version,v_job.attempts;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_claim_tenant_export_job() FROM PUBLIC;

COMMIT;
