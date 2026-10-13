BEGIN;
-- A warehouse worker can perform COUNT but cannot authorize inventory losses.
-- OWNER inherits the wildcard grant; ADMIN explicitly gets this narrow right.
INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT tenant_id,id,'wms.count.approve','all'
FROM tenant_role WHERE code='ADMIN'
ON CONFLICT (role_id,permission_code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.corebiz_grant_wms_count_reviewer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.code='ADMIN' THEN
    INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
    VALUES(NEW.tenant_id,NEW.id,'wms.count.approve','all')
    ON CONFLICT(role_id,permission_code) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.corebiz_grant_wms_count_reviewer() FROM PUBLIC;
DROP TRIGGER IF EXISTS tenant_role_wms_count_reviewer ON tenant_role;
CREATE TRIGGER tenant_role_wms_count_reviewer AFTER INSERT ON tenant_role
FOR EACH ROW EXECUTE FUNCTION public.corebiz_grant_wms_count_reviewer();
COMMIT;
