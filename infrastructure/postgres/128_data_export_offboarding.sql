BEGIN;

CREATE TABLE tenant_export_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  requested_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  format text NOT NULL
    CHECK (format IN ('JSON_GZIP','CSV_GZIP')),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','READY','FAILED','EXPIRED','CANCELLED')),
  schema_version text NOT NULL DEFAULT 'corebiz-export-v1',
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact bytea,
  content_type text,
  filename text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  last_error text,
  expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  downloaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_export_job_queue_idx
  ON tenant_export_job(status,lease_until,created_at)
  WHERE status IN ('PENDING','PROCESSING','FAILED');

CREATE INDEX tenant_export_job_tenant_idx
  ON tenant_export_job(tenant_id,created_at DESC);

CREATE TABLE tenant_offboarding_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  reviewed_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  readiness text NOT NULL
    CHECK (readiness IN ('READY','BLOCKED')),
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_offboarding_review_tenant_idx
  ON tenant_offboarding_review(tenant_id,created_at DESC);

ALTER TABLE tenant_export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_offboarding_review ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_export_job_isolation
  ON tenant_export_job
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY tenant_offboarding_review_isolation
  ON tenant_offboarding_review
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

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
  SELECT j.*
  INTO v_job
  FROM tenant_export_job j
  WHERE (
      j.status IN ('PENDING','FAILED')
      OR (
        j.status='PROCESSING'
        AND j.lease_until IS NOT NULL
        AND j.lease_until <= now()
      )
    )
    AND j.attempts < 5
  ORDER BY j.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE tenant_export_job
  SET status='PROCESSING',
      attempts=attempts+1,
      lease_until=now()+interval '15 minutes',
      started_at=COALESCE(started_at,now()),
      last_error=NULL,
      updated_at=now()
  WHERE id=v_job.id;

  RETURN QUERY
  SELECT
    v_job.id,
    v_job.tenant_id,
    v_job.requested_by_membership_id,
    v_job.format,
    v_job.schema_version,
    v_job.attempts+1;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_claim_tenant_export_job() FROM PUBLIC;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'data.export','all'
FROM tenant_role r
WHERE r.code IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'data.offboarding.read','all'
FROM tenant_role r
WHERE r.code IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

COMMIT;
