BEGIN;

CREATE TABLE tenant_activation_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  first_value_at timestamptz,
  completed_at timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(completed_at IS NULL OR first_value_at IS NOT NULL)
);

ALTER TABLE tenant_activation_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_activation_state_isolation
  ON tenant_activation_state
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

INSERT INTO tenant_activation_state(tenant_id)
SELECT id FROM tenant
ON CONFLICT (tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION corebiz_seed_activation_state(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO tenant_activation_state(tenant_id)
  VALUES (p_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_activation_state(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_activation_state_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_activation_state(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_activation_state
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_activation_state_trigger();

COMMIT;
