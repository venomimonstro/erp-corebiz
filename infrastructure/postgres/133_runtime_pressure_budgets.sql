BEGIN;

CREATE TABLE tenant_runtime_pressure_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 120),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  current_value integer CHECK (current_value IS NULL OR current_value >= 0),
  limit_value integer CHECK (limit_value IS NULL OR limit_value > 0),
  retry_after_seconds integer CHECK (
    retry_after_seconds IS NULL OR retry_after_seconds BETWEEN 1 AND 86400
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_runtime_pressure_event_recent_idx
  ON tenant_runtime_pressure_event(tenant_id,created_at DESC);

ALTER TABLE tenant_runtime_pressure_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_runtime_pressure_event_isolation
  ON tenant_runtime_pressure_event
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'runtime.pressure.read','all'
FROM tenant_role r
WHERE r.code IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

COMMIT;
