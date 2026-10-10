BEGIN;

CREATE TABLE tenant_launch_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'PREPARING'
    CHECK(stage IN ('PREPARING','HYPERCARE','LIVE')),
  go_live_at timestamptz,
  hypercare_until timestamptz,
  last_review_id uuid,
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(
    stage='PREPARING'
    OR go_live_at IS NOT NULL
  )
);

CREATE TABLE tenant_go_live_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK(decision IN ('GO','NO_GO')),
  readiness_snapshot jsonb NOT NULL,
  note text,
  reviewed_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_launch_state
  ADD CONSTRAINT tenant_launch_state_review_fk
  FOREIGN KEY(last_review_id)
  REFERENCES tenant_go_live_review(id) ON DELETE SET NULL;

CREATE INDEX tenant_go_live_review_history_idx
  ON tenant_go_live_review(tenant_id,reviewed_at DESC);

ALTER TABLE tenant_launch_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_go_live_review ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_launch_state_isolation
  ON tenant_launch_state
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE POLICY tenant_go_live_review_isolation
  ON tenant_go_live_review
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

INSERT INTO tenant_launch_state(tenant_id)
SELECT id FROM tenant
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'go_live.read','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'go_live.manage','all'
FROM tenant_role r
WHERE r.code='ADMIN'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION corebiz_seed_tenant_launch_state(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  INSERT INTO tenant_launch_state(tenant_id)
  VALUES (p_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_tenant_launch_state(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_launch_state_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_tenant_launch_state(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_launch_state
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_launch_state_trigger();

COMMIT;
