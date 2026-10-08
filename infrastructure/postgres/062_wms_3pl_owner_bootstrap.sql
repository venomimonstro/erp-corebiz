BEGIN;

CREATE OR REPLACE FUNCTION corebiz_seed_default_inventory_owner(
  p_tenant_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO inventory_owner(
    tenant_id,owner_type,code,name,is_default,status
  )
  VALUES (
    p_tenant_id,'INTERNAL','INTERNAL','Собственный товар',true,'ACTIVE'
  )
  ON CONFLICT (tenant_id,code) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_default_inventory_owner(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_inventory_owner_bootstrap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_default_inventory_owner(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_inventory_owner_v1
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_inventory_owner_bootstrap();

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM corebiz_seed_default_inventory_owner(t.id);
  END LOOP;
END;
$$;

COMMIT;
