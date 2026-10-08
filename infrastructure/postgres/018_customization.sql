BEGIN;

CREATE TABLE custom_field_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type text NOT NULL
    CHECK (entity_type IN ('DEAL','PARTY','PRODUCT','SALES_ORDER','PURCHASE_ORDER')),
  field_key text NOT NULL,
  label text NOT NULL,
  data_type text NOT NULL
    CHECK (data_type IN ('TEXT','NUMBER','DATE','BOOLEAN','SELECT','MULTISELECT')),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_required boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, field_key)
);

CREATE TABLE custom_field_value (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  definition_id uuid NOT NULL REFERENCES custom_field_definition(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  value jsonb NOT NULL,
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, entity_id)
);

CREATE INDEX custom_field_value_entity_idx
  ON custom_field_value(tenant_id, entity_type, entity_id);

CREATE TABLE form_layout_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  published_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, version)
);

CREATE UNIQUE INDEX form_layout_one_published_uq
  ON form_layout_version(tenant_id, entity_type)
  WHERE status = 'PUBLISHED';

CREATE TABLE saved_view (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  name text NOT NULL,
  owner_membership_id uuid REFERENCES tenant_membership(id) ON DELETE CASCADE,
  is_shared boolean NOT NULL DEFAULT false,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saved_view_entity_idx
  ON saved_view(tenant_id, entity_type, owner_membership_id);

CREATE TABLE capability_toggle (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  capability_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, capability_key)
);

ALTER TABLE custom_field_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_layout_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_toggle ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'custom_field_definition','custom_field_value',
    'form_layout_version','saved_view','capability_toggle'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

INSERT INTO capability_toggle(tenant_id, capability_key, enabled)
SELECT t.id, x.capability_key, true
FROM tenant t
CROSS JOIN (VALUES
  ('crm'),
  ('tasks'),
  ('catalog'),
  ('sales'),
  ('procurement'),
  ('inventory'),
  ('finance')
) AS x(capability_key)
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'customization.manage', 'all'
FROM tenant_role r
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

COMMIT;
