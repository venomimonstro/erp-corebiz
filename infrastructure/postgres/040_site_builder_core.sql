BEGIN;

CREATE TABLE site_project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  public_slug text NOT NULL
    CHECK (public_slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (public_slug)
);

CREATE INDEX site_project_tenant_idx
  ON site_project(tenant_id,status,updated_at DESC);

CREATE TABLE site_page (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES site_project(id) ON DELETE CASCADE,
  slug text NOT NULL
    CHECK (
      slug = '' OR
      slug ~ '^[a-z0-9][a-z0-9/-]{0,120}$'
    ),
  title text NOT NULL,
  seo_title text,
  seo_description text,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  sort_order integer NOT NULL DEFAULT 100,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,slug)
);

CREATE INDEX site_page_project_idx
  ON site_page(tenant_id,project_id,status,sort_order,id);

CREATE TABLE site_page_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES site_page(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  state text NOT NULL DEFAULT 'DRAFT'
    CHECK (state IN ('DRAFT','PUBLISHED','SUPERSEDED')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  published_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id,version_no)
);

CREATE UNIQUE INDEX site_page_one_draft_idx
  ON site_page_version(page_id)
  WHERE state='DRAFT';

CREATE UNIQUE INDEX site_page_one_published_idx
  ON site_page_version(page_id)
  WHERE state='PUBLISHED';

CREATE TABLE site_block (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES site_page_version(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  block_type text NOT NULL
    CHECK (block_type IN (
      'HERO','TEXT','FEATURES','CTA','IMAGE','GALLERY',
      'PRODUCTS','SERVICES','FAQ','CONTACTS','SPACER'
    )),
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id,position)
);

CREATE INDEX site_block_version_idx
  ON site_block(tenant_id,version_id,position);

CREATE TABLE site_publish_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES site_project(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES site_page(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES site_page_version(id) ON DELETE RESTRICT,
  actor_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_project ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_page_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_publish_event ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'site_project','site_page','site_page_version',
    'site_block','site_publish_event'
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

CREATE OR REPLACE FUNCTION corebiz_public_site_page(
  p_public_slug text,
  p_page_slug text DEFAULT ''
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'project', jsonb_build_object(
      'id', sp.id,
      'name', sp.name,
      'publicSlug', sp.public_slug,
      'theme', sp.theme,
      'settings', sp.settings
    ),
    'page', jsonb_build_object(
      'id', pg.id,
      'slug', pg.slug,
      'title', pg.title,
      'seoTitle', pg.seo_title,
      'seoDescription', pg.seo_description
    ),
    'version', jsonb_build_object(
      'id', pv.id,
      'versionNo', pv.version_no,
      'publishedAt', pv.published_at
    ),
    'blocks', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'type', b.block_type,
          'position', b.position,
          'props', b.props
        )
        ORDER BY b.position
      )
      FROM site_block b
      WHERE b.version_id=pv.id
    ), '[]'::jsonb)
  )
  FROM site_project sp
  JOIN site_page pg
    ON pg.project_id=sp.id
   AND pg.tenant_id=sp.tenant_id
   AND pg.status='ACTIVE'
  JOIN site_page_version pv
    ON pv.page_id=pg.id
   AND pv.tenant_id=sp.tenant_id
   AND pv.state='PUBLISHED'
  WHERE sp.public_slug=lower(trim(p_public_slug))
    AND sp.status='PUBLISHED'
    AND pg.slug=COALESCE(trim(both '/' from p_page_slug),'')
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_public_site_page(text,text) FROM PUBLIC;

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
