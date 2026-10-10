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
    (p_tenant_id, 'dance', true),
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

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id,r.id,x.permission_code,x.scope
FROM tenant_role r
JOIN (
  VALUES
    ('ADMIN','dance.read','all'),
    ('ADMIN','dance.write','all'),
    ('SALES_HEAD','dance.read','all'),
    ('SALES_HEAD','dance.write','all'),
    ('SERVICE_STAFF','dance.read','own'),
    ('SERVICE_STAFF','dance.write','own'),
    ('FINANCE','dance.read','all'),
    ('VIEWER','dance.read','all')
) AS x(role_code,permission_code,scope)
  ON x.role_code=r.code
ON CONFLICT (role_id,permission_code)
DO UPDATE SET scope=EXCLUDED.scope;

COMMIT;
