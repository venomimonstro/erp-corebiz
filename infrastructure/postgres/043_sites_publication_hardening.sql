BEGIN;

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS public_slug text,
  ADD COLUMN IF NOT EXISTS theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE site
SET public_slug =
  lower(regexp_replace(code, '[^a-z0-9-]+', '-', 'g'))
  || '-' ||
  substr(replace(id::text,'-',''),1,8)
WHERE public_slug IS NULL OR public_slug='';

ALTER TABLE site
  ALTER COLUMN public_slug SET NOT NULL;

ALTER TABLE site
  ADD CONSTRAINT site_public_slug_format
  CHECK (public_slug ~ '^[a-z0-9][a-z0-9-]{2,80}$');

CREATE UNIQUE INDEX IF NOT EXISTS site_public_slug_unique_idx
  ON site(public_slug);

CREATE UNIQUE INDEX IF NOT EXISTS site_page_one_draft_idx
  ON site_page_version(page_id)
  WHERE status='DRAFT';

CREATE UNIQUE INDEX IF NOT EXISTS site_page_one_published_idx
  ON site_page_version(page_id)
  WHERE status='PUBLISHED';

CREATE TABLE IF NOT EXISTS site_publish_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES site_page(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES site_page_version(id) ON DELETE RESTRICT,
  actor_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_publish_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_publish_event_isolation ON site_publish_event;
CREATE POLICY site_publish_event_isolation
  ON site_publish_event
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION corebiz_public_site_page(
  p_public_slug text,
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
  FROM site s
  JOIN site_page p
    ON p.tenant_id=s.tenant_id
   AND p.site_id=s.id
   AND p.status='ACTIVE'
  JOIN site_page_version v
    ON v.tenant_id=s.tenant_id
   AND v.id=p.published_version_id
   AND v.page_id=p.id
   AND v.status='PUBLISHED'
  WHERE s.status='ACTIVE'
    AND s.public_slug=lower(trim(p_public_slug))
    AND p.slug=CASE
      WHEN trim(COALESCE(p_page_slug,'')) IN ('','/') THEN '/'
      ELSE '/' || trim(both '/' from p_page_slug)
    END
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_public_site_page(text,text) FROM PUBLIC;

COMMIT;
