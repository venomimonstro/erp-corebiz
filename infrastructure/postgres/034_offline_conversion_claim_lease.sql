BEGIN;

CREATE OR REPLACE FUNCTION corebiz_claim_offline_conversion_job()
RETURNS TABLE(
  job_id uuid,
  tenant_id uuid,
  connection_id uuid,
  counter_id bigint,
  target text,
  credentials_ciphertext text,
  conversion_type text,
  conversion_id uuid,
  yclid text,
  occurred_at timestamptz,
  value_minor bigint,
  currency char(3),
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job offline_conversion_job%ROWTYPE;
BEGIN
  SELECT j.*
  INTO v_job
  FROM offline_conversion_job j
  WHERE j.status IN ('PENDING','FAILED')
    AND (j.retry_at IS NULL OR j.retry_at <= now())
    AND j.attempts < 8
  ORDER BY j.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE offline_conversion_job
  SET attempts = attempts + 1,
      retry_at = now() + interval '5 minutes'
  WHERE id = v_job.id;

  RETURN QUERY
  SELECT
    v_job.id,
    v_job.tenant_id,
    v_job.connection_id,
    c.counter_id,
    v_job.target,
    c.credentials_ciphertext,
    v_job.conversion_type,
    v_job.conversion_id,
    v_job.yclid,
    v_job.occurred_at,
    v_job.value_minor,
    v_job.currency,
    v_job.attempts + 1
  FROM offline_conversion_connection c
  WHERE c.id = v_job.connection_id
    AND c.tenant_id = v_job.tenant_id
    AND c.status <> 'DISABLED';
END;
$$;

REVOKE ALL ON FUNCTION corebiz_claim_offline_conversion_job() FROM PUBLIC;

COMMIT;
