BEGIN;
CREATE TABLE crm_next_action(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES crm_deal(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES task(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,deal_id,idempotency_key),
  UNIQUE(tenant_id,task_id)
);
CREATE INDEX crm_next_action_deal_idx ON crm_next_action(tenant_id,deal_id,created_at DESC);
ALTER TABLE crm_next_action ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_next_action_tenant ON crm_next_action
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
  GRANT SELECT,INSERT,UPDATE ON crm_next_action TO corebiz_app;
 END IF;
END $$;
COMMIT;
