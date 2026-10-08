BEGIN;

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
      'code', s.code,
      'publicSlug', s.public_slug,
      'hostname', (
        SELECT d.hostname
        FROM site_domain d
        WHERE d.tenant_id=s.tenant_id
          AND d.site_id=s.id
          AND d.status='ACTIVE'
          AND d.is_primary=true
        LIMIT 1
      ),
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
      'code', s.code,
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

REVOKE ALL ON FUNCTION corebiz_public_site_page(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION corebiz_public_site_page_by_host(text,text) FROM PUBLIC;

COMMIT;
