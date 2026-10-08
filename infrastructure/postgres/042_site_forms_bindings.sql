BEGIN;

CREATE TABLE site_form_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  name text NOT NULL,
  public_key text NOT NULL UNIQUE,
  action text NOT NULL
    CHECK (action IN ('CRM_LEAD','BOOKING')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DISABLED')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX site_form_binding_site_idx
  ON site_form_binding(tenant_id,site_id,status);

CREATE TABLE site_submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES site_form_binding(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','PROCESSED','FAILED','REJECTED')),
  result_type text,
  result_id uuid,
  last_error text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (binding_id,idempotency_key)
);

CREATE INDEX site_submission_recent_idx
  ON site_submission(tenant_id,binding_id,submitted_at DESC);

ALTER TABLE site_form_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_submission ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_form_binding_isolation
  ON site_form_binding
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY site_submission_isolation
  ON site_submission
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION corebiz_resolve_site_form_binding(p_public_key text)
RETURNS TABLE(
  binding_id uuid,
  tenant_id uuid,
  site_id uuid,
  action text,
  config jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id,tenant_id,site_id,action,config
  FROM site_form_binding
  WHERE public_key=p_public_key
    AND status='ACTIVE'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_site_form_binding(text) FROM PUBLIC;

COMMIT;
