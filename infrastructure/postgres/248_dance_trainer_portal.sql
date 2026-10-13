BEGIN;
-- Minimal trainer access: personal calendar only, no company CRM, finance,
-- payroll, client PII, role administration or other trainer schedules.
CREATE OR REPLACE FUNCTION public.corebiz_seed_dance_trainer_role(p_tenant_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_role uuid;
BEGIN
 INSERT INTO tenant_role(tenant_id,code,name,is_system)
 VALUES(p_tenant_id,'DANCE_TRAINER','Тренер студии',true)
 ON CONFLICT(tenant_id,code) DO UPDATE SET name=EXCLUDED.name,is_system=true
 RETURNING id INTO v_role;
 INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
 VALUES(p_tenant_id,v_role,'dance.trainer.read','own')
 ON CONFLICT(role_id,permission_code) DO UPDATE SET scope='own';
 -- An ADMIN who also coaches may view only their own calendar, not other
 -- trainers. This is not an ownership or full studio finance grant.
 INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
 SELECT p_tenant_id,r.id,'dance.trainer.read','own'
 FROM tenant_role r
 WHERE r.tenant_id=p_tenant_id AND r.code='ADMIN'
 ON CONFLICT(role_id,permission_code) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.corebiz_seed_dance_trainer_role(uuid) FROM PUBLIC;
DO $$
DECLARE t record;
BEGIN
 FOR t IN SELECT id FROM tenant LOOP
   PERFORM public.corebiz_seed_dance_trainer_role(t.id);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.corebiz_tenant_dance_trainer_role_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.corebiz_seed_dance_trainer_role(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tenant_seed_dance_trainer_role ON tenant;
CREATE TRIGGER tenant_seed_dance_trainer_role AFTER INSERT ON tenant
FOR EACH ROW EXECUTE FUNCTION public.corebiz_tenant_dance_trainer_role_trigger();
COMMIT;
