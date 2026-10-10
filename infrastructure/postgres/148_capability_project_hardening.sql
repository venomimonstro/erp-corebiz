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
    (p_tenant_id, 'finance', true),
    (p_tenant_id, 'accounting', true),
    (p_tenant_id, 'service', true),
    (p_tenant_id, 'projects', true),
    (p_tenant_id, 'channels', true),
    (p_tenant_id, 'oms', true),
    (p_tenant_id, 'sites', true),
    (p_tenant_id, 'growth', true),
    (p_tenant_id, 'wms', true),
    (p_tenant_id, 'workflow', true),
    (p_tenant_id, 'support', true)
  ON CONFLICT (tenant_id, capability_key) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_capabilities(uuid) FROM PUBLIC;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM corebiz_seed_capabilities(t.id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_seed_project_permissions(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO role_permission(
    tenant_id, role_id, permission_code, scope
  )
  SELECT
    r.tenant_id,
    r.id,
    x.permission_code,
    x.scope
  FROM (
    VALUES
      ('ADMIN', 'projects.read', 'all'),
      ('ADMIN', 'projects.write', 'all'),
      ('SALES_HEAD', 'projects.read', 'all'),
      ('SALES_HEAD', 'projects.write', 'all'),
      ('SALES_MANAGER', 'projects.read', 'own'),
      ('SALES_MANAGER', 'projects.write', 'own'),
      ('SERVICE_STAFF', 'projects.read', 'own'),
      ('SERVICE_STAFF', 'projects.write', 'own'),
      ('FINANCE', 'projects.read', 'all'),
      ('VIEWER', 'projects.read', 'all')
  ) AS x(role_code, permission_code, scope)
  JOIN tenant_role r
    ON r.tenant_id=p_tenant_id
   AND r.code=x.role_code
  ON CONFLICT (role_id, permission_code)
  DO UPDATE SET scope=EXCLUDED.scope;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_project_permissions(uuid) FROM PUBLIC;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM corebiz_seed_project_permissions(t.id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_tenant_project_permission_bootstrap_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_project_permissions(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION corebiz_tenant_project_permission_bootstrap_trigger() FROM PUBLIC;

DROP TRIGGER IF EXISTS zz_tenant_seed_project_permissions ON tenant;
CREATE TRIGGER zz_tenant_seed_project_permissions
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_project_permission_bootstrap_trigger();

CREATE UNIQUE INDEX IF NOT EXISTS work_project_source_deal_uq
  ON work_project(tenant_id, source_deal_id)
  WHERE source_deal_id IS NOT NULL;

COMMIT;
