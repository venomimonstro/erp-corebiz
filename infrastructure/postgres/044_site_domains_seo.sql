BEGIN;

ALTER TABLE site_page_version
  ADD COLUMN IF NOT EXISTS meta_robots text NOT NULL DEFAULT 'index,follow',
  ADD COLUMN IF NOT EXISTS canonical_path text,
  ADD COLUMN IF NOT EXISTS og_title text,
  ADD COLUMN IF NOT EXISTS og_description text,
  ADD COLUMN IF NOT EXISTS og_image_url text;

CREATE TABLE site_domain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  verification_token text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','VERIFIED','ACTIVE','DISABLED')),
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  activated_at timestamptz,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hostname)
);

CREATE INDEX site_domain_site_idx
  ON site_domain(tenant_id,site_id,status);

CREATE UNIQUE INDEX site_domain_one_primary_idx
  ON site_domain(site_id)
  WHERE is_primary=true AND status='ACTIVE';

ALTER TABLE site_domain ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_domain_isolation
  ON site_domain
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION corebiz_public_site_page_by_host(
  p_hostname text,
  p_page_slug text DEFAULT '/'
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'site', jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'publicSlug', s.public_slug,
      'hostname', d.hostname,
      'theme', s.theme,
      'settings', s.settings
    ),
    'page', jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'slug', p.slug,
      'pageType', p.page_type
    ),
    'version', jsonb_build_object(
      'id', v.id,
      'versionNo', v.version_no,
      'title', v.title,
      'metaDescription', v.meta_description,
      'metaRobots', v.meta_robots,
      'canonicalPath', v.canonical_path,
      'ogTitle', v.og_title,
      'ogDescription', v.og_description,
      'ogImageUrl', v.og_image_url,
      'publishedAt', v.published_at
    ),
    'blocks', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'type', b.block_type,
          'sortOrder', b.sort_order,
          'config', b.config
        )
        ORDER BY b.sort_order
      )
      FROM site_block b
      WHERE b.tenant_id=s.tenant_id
        AND b.page_version_id=v.id
    ), '[]'::jsonb)
  )
  FROM site_domain d
  JOIN site s
    ON s.tenant_id=d.tenant_id
   AND s.id=d.site_id
   AND s.status='ACTIVE'
  JOIN site_page p
    ON p.tenant_id=s.tenant_id
   AND p.site_id=s.id
   AND p.status='ACTIVE'
  JOIN site_page_version v
    ON v.tenant_id=s.tenant_id
   AND v.id=p.published_version_id
   AND v.page_id=p.id
   AND v.status='PUBLISHED'
  WHERE d.hostname=lower(trim(trailing '.' from p_hostname))
    AND d.status='ACTIVE'
    AND p.slug=CASE
      WHEN trim(COALESCE(p_page_slug,'')) IN ('','/') THEN '/'
      ELSE '/' || trim(both '/' from p_page_slug)
    END
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_public_site_page_by_host(text,text) FROM PUBLIC;

COMMIT;
