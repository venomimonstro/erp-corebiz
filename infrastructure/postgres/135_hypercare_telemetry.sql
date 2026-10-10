BEGIN;

CREATE TABLE tenant_hypercare_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK(stage IN ('PREPARING','HYPERCARE','LIVE')),
  health text NOT NULL CHECK(health IN ('GREEN','YELLOW','RED')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  captured_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_hypercare_snapshot_history_idx
  ON tenant_hypercare_snapshot(tenant_id,captured_at DESC);

ALTER TABLE tenant_hypercare_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_hypercare_snapshot_isolation
  ON tenant_hypercare_snapshot
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

COMMIT;
