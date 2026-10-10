BEGIN;

CREATE TABLE tenant_runtime_lease (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  membership_id uuid REFERENCES tenant_membership(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 120),
  scope text NOT NULL CHECK (scope IN ('TENANT','MEMBERSHIP')),
  lease_key text NOT NULL CHECK (length(lease_key) BETWEEN 8 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope='TENANT' AND membership_id IS NULL)
    OR
    (scope='MEMBERSHIP' AND membership_id IS NOT NULL)
  ),
  UNIQUE (tenant_id,lease_key)
);

CREATE INDEX tenant_runtime_lease_active_idx
  ON tenant_runtime_lease(tenant_id,operation,scope,expires_at);

ALTER TABLE tenant_runtime_lease ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_runtime_lease_isolation
  ON tenant_runtime_lease
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
