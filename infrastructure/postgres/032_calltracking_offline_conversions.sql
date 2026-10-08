BEGIN;

CREATE TABLE calltracking_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  tracker_site_id uuid REFERENCES tracker_site(id) ON DELETE SET NULL,
  provider text NOT NULL
    CHECK (provider IN ('CALLTOUCH','ROISTAT','MANGO','OTHER')),
  name text NOT NULL,
  webhook_secret_hash text NOT NULL,
  credentials_ciphertext text,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DEGRADED','DISABLED')),
  last_received_at timestamptz,
  last_error text,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_call (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES calltracking_connection(id) ON DELETE CASCADE,
  external_call_id text NOT NULL,
  visitor_id uuid REFERENCES marketing_visitor(id) ON DELETE SET NULL,
  session_id uuid REFERENCES marketing_session(id) ON DELETE SET NULL,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  caller_phone_hash text,
  started_at timestamptz NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  status text NOT NULL
    CHECK (status IN ('ANSWERED','MISSED','BUSY','FAILED','UNKNOWN')),
  outcome text,
  source text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_call_id)
);

CREATE INDEX marketing_call_party_idx
  ON marketing_call(tenant_id, party_id, started_at DESC);

CREATE INDEX marketing_call_session_idx
  ON marketing_call(tenant_id, session_id, started_at DESC);

CREATE TABLE offline_conversion_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('YANDEX_METRICA')),
  name text NOT NULL,
  counter_id bigint NOT NULL CHECK (counter_id > 0),
  target text NOT NULL,
  credentials_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DEGRADED','DISABLED')),
  last_export_at timestamptz,
  last_error text,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE offline_conversion_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES offline_conversion_connection(id) ON DELETE CASCADE,
  conversion_type text NOT NULL
    CHECK (conversion_type IN ('SALES_ORDER','SERVICE_BOOKING')),
  conversion_id uuid NOT NULL,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  yclid text NOT NULL,
  target text NOT NULL,
  occurred_at timestamptz NOT NULL,
  value_minor bigint NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','UPLOADED','PROCESSED','FAILED','SKIPPED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at timestamptz,
  provider_upload_id text,
  provider_status text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  processed_at timestamptz,
  UNIQUE (connection_id, conversion_type, conversion_id, target)
);

CREATE INDEX offline_conversion_job_queue_idx
  ON offline_conversion_job(status, retry_at, created_at)
  WHERE status IN ('PENDING','FAILED');

ALTER TABLE calltracking_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_conversion_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_conversion_job ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'calltracking_connection','marketing_call',
    'offline_conversion_connection','offline_conversion_job'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_resolve_calltracking_connection(
  p_connection_id uuid
)
RETURNS TABLE(
  connection_id uuid,
  tenant_id uuid,
  tracker_site_id uuid,
  webhook_secret_hash text,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, tenant_id, tracker_site_id, webhook_secret_hash, status
  FROM calltracking_connection
  WHERE id = p_connection_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_calltracking_connection(uuid) FROM PUBLIC;

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
      retry_at = NULL
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
