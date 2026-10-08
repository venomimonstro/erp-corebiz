BEGIN;

CREATE OR REPLACE FUNCTION corebiz_claim_offline_conversion_status_job()
RETURNS TABLE(
  job_id uuid,
  tenant_id uuid,
  connection_id uuid,
  counter_id bigint,
  credentials_ciphertext text,
  provider_upload_id text
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
  WHERE j.status = 'UPLOADED'
    AND j.provider_upload_id IS NOT NULL
    AND (j.retry_at IS NULL OR j.retry_at <= now())
  ORDER BY j.uploaded_at NULLS FIRST, j.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE offline_conversion_job
  SET retry_at = now() + interval '2 minutes'
  WHERE id = v_job.id;

  RETURN QUERY
  SELECT
    v_job.id,
    v_job.tenant_id,
    v_job.connection_id,
    c.counter_id,
    c.credentials_ciphertext,
    v_job.provider_upload_id
  FROM offline_conversion_connection c
  WHERE c.id = v_job.connection_id
    AND c.tenant_id = v_job.tenant_id
    AND c.status <> 'DISABLED';
END;
$$;

REVOKE ALL ON FUNCTION corebiz_claim_offline_conversion_status_job() FROM PUBLIC;

COMMIT;
