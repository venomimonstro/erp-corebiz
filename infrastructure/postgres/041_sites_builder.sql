BEGIN;

CREATE TABLE site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,code)
);

CREATE TABLE site_page (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  page_type text NOT NULL DEFAULT 'CONTENT'
    CHECK (page_type IN ('HOME','CONTENT','CATALOG','PRODUCT','BOOKING','LANDING')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  published_version_id uuid,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id,slug)
);

CREATE TABLE site_page_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES site_page(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  title text NOT NULL,
  meta_description text,
  published_at timestamptz,
  published_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id,version_no)
);

ALTER TABLE site_page
  ADD CONSTRAINT site_page_published_version_fk
  FOREIGN KEY (published_version_id)
  REFERENCES site_page_version(id)
  ON DELETE SET NULL;

CREATE TABLE site_block (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  page_version_id uuid NOT NULL REFERENCES site_page_version(id) ON DELETE CASCADE,
  block_type text NOT NULL
    CHECK (block_type IN (
      'HERO','TEXT','IMAGE','FEATURES','CTA',
      'FORM','BOOKING','CATALOG','PRODUCT_GRID','SPACER'
    )),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_version_id,sort_order)
);

CREATE INDEX site_page_site_idx
  ON site_page(tenant_id,site_id,status,updated_at DESC);

CREATE INDEX site_block_version_idx
  ON site_block(tenant_id,page_version_id,sort_order);

ALTER TABLE site ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_page_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_block ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'site','site_page','site_page_version','site_block'
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

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'sites.read','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'sites.manage','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD')
ON CONFLICT DO NOTHING;

COMMIT;
