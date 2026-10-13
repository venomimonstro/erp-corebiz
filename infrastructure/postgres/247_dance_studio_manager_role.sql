BEGIN;
-- Studio receptionists can operate bookings, subscriptions and customer debt
-- WITHOUT access to company bank accounts, payroll or administrative roles.
CREATE OR REPLACE FUNCTION public.corebiz_seed_dance_manager_role(p_tenant_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE v_role uuid;
BEGIN
 INSERT INTO tenant_role(tenant_id,code,name,is_system)
 VALUES(p_tenant_id,'DANCE_MANAGER','Менеджер студии',true)
 ON CONFLICT(tenant_id,code)
 DO UPDATE SET name=EXCLUDED.name,is_system=true
 RETURNING id INTO v_role;
 INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
 SELECT p_tenant_id,v_role,p.code,'all' FROM (VALUES
   ('dance.read'),('dance.write'),('dance.charges.read'),
   ('service.read'),('service.write'),('crm.read'),('crm.write'),
   ('tasks.read'),('tasks.write'),('catalog.read')
 ) p(code)
 ON CONFLICT(role_id,permission_code) DO UPDATE SET scope='all';
END;
$$;
REVOKE ALL ON FUNCTION public.corebiz_seed_dance_manager_role(uuid) FROM PUBLIC;
DO $$
DECLARE t record;
BEGIN
 FOR t IN SELECT id FROM tenant LOOP
   PERFORM public.corebiz_seed_dance_manager_role(t.id);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.corebiz_seed_dance_manager_role_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.corebiz_seed_dance_manager_role(NEW.id);
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tenant_seed_dance_manager_role ON tenant;
CREATE TRIGGER tenant_seed_dance_manager_role AFTER INSERT ON tenant
FOR EACH ROW EXECUTE FUNCTION public.corebiz_seed_dance_manager_role_trigger();
COMMIT;
