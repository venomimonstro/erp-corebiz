BEGIN;

CREATE TABLE channel_sync_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('OZON','WILDBERRIES','YANDEX_MARKET')),
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at timestamptz,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_orders integer NOT NULL DEFAULT 0 CHECK (imported_orders >= 0),
  updated_orders integer NOT NULL DEFAULT 0 CHECK (updated_orders >= 0),
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to > period_from),
  CHECK (period_to - period_from <= interval '31 days')
);

CREATE INDEX channel_sync_job_queue_idx
  ON channel_sync_job(status,retry_at,created_at)
  WHERE status IN ('PENDING','RUNNING','FAILED');

ALTER TABLE channel_sync_job ENABLE ROW LEVEL SECURITY;

CREATE POLICY channel_sync_job_isolation
  ON channel_sync_job
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION corebiz_claim_channel_sync_job()
RETURNS TABLE(
  job_id uuid,
  tenant_id uuid,
  connection_id uuid,
  provider text,
  period_from timestamptz,
  period_to timestamptz,
  cursor jsonb,
  attempts integer,
  credentials_ciphertext text,
  config jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job channel_sync_job%ROWTYPE;
BEGIN
  SELECT j.*
  INTO v_job
  FROM channel_sync_job j
  JOIN channel_connection c
    ON c.id=j.connection_id
   AND c.tenant_id=j.tenant_id
  WHERE (
      j.status IN ('PENDING','FAILED')
      OR (
        j.status='RUNNING'
        AND j.started_at < now() - interval '10 minutes'
      )
    )
    AND (j.retry_at IS NULL OR j.retry_at <= now())
    AND j.attempts < 8
    AND c.status <> 'DISABLED'
    AND c.credentials_ciphertext IS NOT NULL
  ORDER BY j.created_at
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE channel_sync_job
  SET status='RUNNING',
      attempts=attempts+1,
      started_at=now(),
      retry_at=now()+interval '10 minutes',
      last_error=NULL
  WHERE id=v_job.id;

  RETURN QUERY
  SELECT
    v_job.id,
    v_job.tenant_id,
    v_job.connection_id,
    v_job.provider,
    v_job.period_from,
    v_job.period_to,
    v_job.cursor,
    v_job.attempts+1,
    c.credentials_ciphertext,
    c.config
  FROM channel_connection c
  WHERE c.id=v_job.connection_id
    AND c.tenant_id=v_job.tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_claim_channel_sync_job() FROM PUBLIC;

COMMIT;
