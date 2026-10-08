BEGIN;

CREATE TABLE tenant_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE role_permission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES tenant_role(id) ON DELETE CASCADE,
  permission_code text NOT NULL,
  scope text NOT NULL DEFAULT 'all'
    CHECK (scope IN ('own', 'team', 'branch', 'all')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_code)
);

CREATE TABLE membership_role (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES tenant_role(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, role_id)
);

CREATE INDEX tenant_role_tenant_idx ON tenant_role(tenant_id);
CREATE INDEX role_permission_tenant_idx ON role_permission(tenant_id);
CREATE INDEX membership_role_tenant_idx ON membership_role(tenant_id);

ALTER TABLE tenant_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_role ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_role_isolation
  ON tenant_role
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY role_permission_isolation
  ON role_permission
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY membership_role_isolation
  ON membership_role
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION corebiz_seed_tenant_roles(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner uuid;
  v_admin uuid;
  v_sales_head uuid;
  v_sales_manager uuid;
  v_procurement uuid;
  v_warehouse uuid;
  v_finance uuid;
  v_viewer uuid;
BEGIN
  INSERT INTO tenant_role(tenant_id, code, name, is_system)
  VALUES
    (p_tenant_id, 'OWNER', 'Владелец', true),
    (p_tenant_id, 'ADMIN', 'Администратор', true),
    (p_tenant_id, 'SALES_HEAD', 'Руководитель продаж', true),
    (p_tenant_id, 'SALES_MANAGER', 'Менеджер продаж', true),
    (p_tenant_id, 'PROCUREMENT', 'Закупщик', true),
    (p_tenant_id, 'WAREHOUSE', 'Склад', true),
    (p_tenant_id, 'FINANCE', 'Финансы', true),
    (p_tenant_id, 'VIEWER', 'Наблюдатель', true)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  SELECT id INTO v_owner FROM tenant_role WHERE tenant_id = p_tenant_id AND code = 'OWNER';
  SELECT id INTO v_admin FROM tenant_role WHERE tenant_id = p_tenant_id AND code = 'ADMIN';
  SELECT id INTO v_sales_head FROM tenant_role WHERE tenant_id = p_tenant_id AND code = 'SALES_HEAD';
  SELECT id INTO v_sales_manager FROM tenant_role WHERE tenant_id = p_tenant_id AND code = 'SALES_MANAGER';
  SELECT id INTO v_procurement FROM tenant_role WHERE tenant_id = p_tenant_id AND code = 'PROCUREMENT';
  SELECT id INTO v_warehouse FROM tenant_role WHERE tenant_id = p_tenant_id AND code = 'WAREHOUSE';
  SELECT id INTO v_finance FROM tenant_role WHERE tenant_id = p_tenant_id AND code = 'FINANCE';
  SELECT id INTO v_viewer FROM tenant_role WHERE tenant_id = p_tenant_id AND code = 'VIEWER';

  INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
  VALUES (p_tenant_id, v_owner, '*', 'all')
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
  SELECT p_tenant_id, v_admin, x.code, 'all'
  FROM (VALUES
    ('platform.settings.manage'),
    ('users.manage'),
    ('roles.manage'),
    ('crm.read'),
    ('crm.write'),
    ('tasks.read'),
    ('tasks.write'),
    ('catalog.read'),
    ('catalog.write'),
    ('sales.read'),
    ('sales.write'),
    ('procurement.read'),
    ('procurement.write'),
    ('inventory.read'),
    ('inventory.write'),
    ('support.read'),
    ('support.write')
  ) AS x(code)
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
  SELECT p_tenant_id, v_sales_head, x.code, x.scope
  FROM (VALUES
    ('crm.read','all'),
    ('crm.write','all'),
    ('tasks.read','all'),
    ('tasks.write','all'),
    ('sales.read','all'),
    ('sales.write','all'),
    ('catalog.read','all')
  ) AS x(code, scope)
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
  SELECT p_tenant_id, v_sales_manager, x.code, x.scope
  FROM (VALUES
    ('crm.read','own'),
    ('crm.write','own'),
    ('tasks.read','own'),
    ('tasks.write','own'),
    ('sales.read','own'),
    ('sales.write','own'),
    ('catalog.read','all')
  ) AS x(code, scope)
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
  SELECT p_tenant_id, v_procurement, x.code, 'all'
  FROM (VALUES
    ('catalog.read'),
    ('procurement.read'),
    ('procurement.write'),
    ('inventory.read')
  ) AS x(code)
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
  SELECT p_tenant_id, v_warehouse, x.code, 'all'
  FROM (VALUES
    ('catalog.read'),
    ('inventory.read'),
    ('inventory.write'),
    ('sales.read'),
    ('procurement.read')
  ) AS x(code)
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
  SELECT p_tenant_id, v_finance, x.code, 'all'
  FROM (VALUES
    ('finance.read'),
    ('finance.write'),
    ('sales.read'),
    ('cost.read'),
    ('margin.read')
  ) AS x(code)
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
  SELECT p_tenant_id, v_viewer, x.code, 'all'
  FROM (VALUES
    ('crm.read'),
    ('tasks.read'),
    ('catalog.read'),
    ('sales.read'),
    ('procurement.read'),
    ('inventory.read')
  ) AS x(code)
  ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_tenant_role_bootstrap_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM corebiz_seed_tenant_roles(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_roles
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_role_bootstrap_trigger();

CREATE OR REPLACE FUNCTION corebiz_membership_role_bootstrap_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
BEGIN
  SELECT id INTO v_role_id
  FROM tenant_role
  WHERE tenant_id = NEW.tenant_id
    AND code = CASE WHEN NEW.is_owner THEN 'OWNER' ELSE 'VIEWER' END;

  IF v_role_id IS NOT NULL THEN
    INSERT INTO membership_role(tenant_id, membership_id, role_id)
    VALUES (NEW.tenant_id, NEW.id, v_role_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER membership_assign_default_role
AFTER INSERT ON tenant_membership
FOR EACH ROW
EXECUTE FUNCTION corebiz_membership_role_bootstrap_trigger();

DO $$
DECLARE
  t record;
  m record;
  role_id uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM corebiz_seed_tenant_roles(t.id);
  END LOOP;

  FOR m IN SELECT id, tenant_id, is_owner FROM tenant_membership LOOP
    SELECT id INTO role_id
    FROM tenant_role
    WHERE tenant_id = m.tenant_id
      AND code = CASE WHEN m.is_owner THEN 'OWNER' ELSE 'VIEWER' END;

    INSERT INTO membership_role(tenant_id, membership_id, role_id)
    VALUES (m.tenant_id, m.id, role_id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

COMMIT;
