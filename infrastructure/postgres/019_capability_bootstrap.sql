BEGIN;

CREATE OR REPLACE FUNCTION corebiz_seed_capabilities(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO capability_toggle(tenant_id, capability_key, enabled)
  VALUES
    (p_tenant_id, 'crm', true),
    (p_tenant_id, 'tasks', true),
    (p_tenant_id, 'catalog', true),
    (p_tenant_id, 'sales', true),
    (p_tenant_id, 'procurement', true),
    (p_tenant_id, 'inventory', true),
    (p_tenant_id, 'finance', true)
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_capabilities(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_capability_bootstrap_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_capabilities(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_capabilities
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_capability_bootstrap_trigger();

COMMIT;
