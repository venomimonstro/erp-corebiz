BEGIN;

DO $$
DECLARE
  t record;
  v_role uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    INSERT INTO tenant_role(tenant_id,code,name,is_system)
    VALUES (t.id,'SERVICE_STAFF','Сотрудник услуг',true)
    ON CONFLICT (tenant_id,code)
    DO UPDATE SET name=EXCLUDED.name,is_system=true
    RETURNING id INTO v_role;

    INSERT INTO role_permission(
      tenant_id,role_id,permission_code,scope
    )
    VALUES
      (t.id,v_role,'service.read','own'),
      (t.id,v_role,'service.write','own'),
      (t.id,v_role,'tasks.read','own'),
      (t.id,v_role,'tasks.write','own'),
      (t.id,v_role,'crm.read','own'),
      (t.id,v_role,'crm.write','own'),
      (t.id,v_role,'catalog.read','all'),
      (t.id,v_role,'sales.read','own')
    ON CONFLICT (role_id,permission_code)
    DO UPDATE SET scope=EXCLUDED.scope;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_seed_service_staff_role(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role uuid;
BEGIN
  INSERT INTO tenant_role(tenant_id,code,name,is_system)
  VALUES (p_tenant_id,'SERVICE_STAFF','Сотрудник услуг',true)
  ON CONFLICT (tenant_id,code)
  DO UPDATE SET name=EXCLUDED.name,is_system=true
  RETURNING id INTO v_role;

  INSERT INTO role_permission(
    tenant_id,role_id,permission_code,scope
  )
  VALUES
    (p_tenant_id,v_role,'service.read','own'),
    (p_tenant_id,v_role,'service.write','own'),
    (p_tenant_id,v_role,'tasks.read','own'),
    (p_tenant_id,v_role,'tasks.write','own'),
    (p_tenant_id,v_role,'crm.read','own'),
    (p_tenant_id,v_role,'crm.write','own'),
    (p_tenant_id,v_role,'catalog.read','all'),
    (p_tenant_id,v_role,'sales.read','own')
  ON CONFLICT (role_id,permission_code)
  DO UPDATE SET scope=EXCLUDED.scope;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_service_staff_role(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_service_staff_role_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_service_staff_role(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_service_staff_role
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_service_staff_role_trigger();

COMMIT;
