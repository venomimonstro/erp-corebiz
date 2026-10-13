BEGIN;
-- Operational co-founder, deliberately NOT tenant owner (is_owner remains
-- immutable and protected by platform membership/role-management guards).
-- Two business partners can administer a dance studio's finances and people
-- without minting a second subscription owner.
CREATE OR REPLACE FUNCTION public.corebiz_seed_dance_partner_role(p_tenant_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE v_role uuid;
BEGIN
 INSERT INTO tenant_role(tenant_id,code,name,is_system)
 VALUES(p_tenant_id,'DANCE_PARTNER','Совладелец: управление студией',true)
 ON CONFLICT(tenant_id,code) DO UPDATE
 SET name=EXCLUDED.name,is_system=true
 RETURNING id INTO v_role;

 INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
 SELECT p_tenant_id,v_role,p.code,'all' FROM (VALUES
   ('dance.read'),('dance.write'),('dance.charges.read'),
   ('finance.read'),('finance.write'),
   ('service.read'),('service.write'),
   ('crm.read'),('crm.write'),
   ('catalog.read'),('catalog.write'),
   ('users.manage'),('roles.manage'),
   ('accounting.policy.manage'),
   ('tasks.read'),('tasks.write')
 ) p(code)
 ON CONFLICT(role_id,permission_code) DO UPDATE SET scope='all';

 -- Teaching is still strictly the partner's OWN resource. Financial
 -- permissions never widen the trainer calendar into other coaches' schedules.
 INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
 VALUES(p_tenant_id,v_role,'dance.trainer.read','own')
 ON CONFLICT(role_id,permission_code) DO UPDATE SET scope='own';
END;
$$;
REVOKE ALL ON FUNCTION public.corebiz_seed_dance_partner_role(uuid) FROM PUBLIC;
DO $$
DECLARE t record;
BEGIN
 FOR t IN SELECT id FROM tenant LOOP
   PERFORM public.corebiz_seed_dance_partner_role(t.id);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.corebiz_tenant_dance_partner_role_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $$
BEGIN
 PERFORM public.corebiz_seed_dance_partner_role(NEW.id);
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tenant_seed_dance_partner_role ON tenant;
CREATE TRIGGER tenant_seed_dance_partner_role AFTER INSERT ON tenant
FOR EACH ROW EXECUTE FUNCTION public.corebiz_tenant_dance_partner_role_trigger();
COMMIT;
