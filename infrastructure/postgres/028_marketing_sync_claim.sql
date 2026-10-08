BEGIN;

CREATE OR REPLACE FUNCTION corebiz_claim_marketing_sync_job()
RETURNS TABLE(
  job_id uuid,
  tenant_id uuid,
  connection_id uuid,
  provider text,
  period_from date,
  period_to date,
  report_name text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job marketing_sync_job%ROWTYPE;
BEGIN
  SELECT *
  INTO v_job
  FROM marketing_sync_job
  WHERE status IN ('PENDING','WAITING_PROVIDER','FAILED')
    AND (retry_at IS NULL OR retry_at <= now())
    AND attempts < 5
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE marketing_sync_job
  SET status = 'RUNNING',
      attempts = attempts + 1,
      started_at = COALESCE(started_at, now()),
      retry_at = NULL
  WHERE id = v_job.id;

  RETURN QUERY
  SELECT
    v_job.id,
    v_job.tenant_id,
    v_job.connection_id,
    v_job.provider,
    v_job.period_from,
    v_job.period_to,
    v_job.report_name,
    v_job.attempts + 1;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_claim_marketing_sync_job() FROM PUBLIC;

COMMIT;
