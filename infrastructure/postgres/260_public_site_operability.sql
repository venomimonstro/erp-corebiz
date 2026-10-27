BEGIN;

-- Published content is still commercial tenant traffic. A platform suspension,
-- cancelled/expired subscription or missing subscription must make every public
-- page/route/tracker resolver fail closed, not only checkout endpoints.

CREATE OR REPLACE FUNCTION public.corebiz_public_site_page(
  p_public_slug text,
  p_page_slug text DEFAULT '/'
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'site', pg_catalog.jsonb_build_object(
      'id',s.id,'name',s.name,'code',s.code,'publicSlug',s.public_slug,
      'hostname',(
        SELECT d.hostname FROM public.site_domain d
        WHERE d.tenant_id=s.tenant_id AND d.site_id=s.id
          AND d.status='ACTIVE' AND d.is_primary=true LIMIT 1
      ),
      'theme',s.theme,'settings',s.settings
    ),
    'page',pg_catalog.jsonb_build_object(
      'id',p.id,'name',p.name,'slug',p.slug,'pageType',p.page_type
    ),
    'version',pg_catalog.jsonb_build_object(
      'id',v.id,'versionNo',v.version_no,'title',v.title,
      'metaDescription',v.meta_description,'metaRobots',v.meta_robots,
      'canonicalPath',v.canonical_path,'ogTitle',v.og_title,
      'ogDescription',v.og_description,'ogImageUrl',v.og_image_url,
      'publishedAt',v.published_at
    ),
    'blocks',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',b.id,'type',b.block_type,'sortOrder',b.sort_order,'config',b.config
        ) ORDER BY b.sort_order
      )
      FROM public.site_block b
      WHERE b.tenant_id=s.tenant_id AND b.page_version_id=v.id
    ),'[]'::jsonb)
  )
  FROM public.site s
  JOIN public.site_page p ON p.tenant_id=s.tenant_id AND p.site_id=s.id
    AND p.status='ACTIVE'
  JOIN public.site_page_version v ON v.tenant_id=s.tenant_id
    AND v.id=p.published_version_id AND v.page_id=p.id AND v.status='PUBLISHED'
  WHERE s.status='ACTIVE'
    AND public.corebiz_tenant_is_operational(s.tenant_id)
    AND s.public_slug=lower(trim(p_public_slug))
    AND p.slug=CASE
      WHEN trim(COALESCE(p_page_slug,'')) IN ('','/') THEN '/'
      ELSE '/'||trim(both '/' from p_page_slug)
    END
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_public_site_page_by_host(
  p_hostname text,
  p_page_slug text DEFAULT '/'
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'site',pg_catalog.jsonb_build_object(
      'id',s.id,'name',s.name,'code',s.code,'publicSlug',s.public_slug,
      'hostname',d.hostname,'theme',s.theme,'settings',s.settings
    ),
    'page',pg_catalog.jsonb_build_object(
      'id',p.id,'name',p.name,'slug',p.slug,'pageType',p.page_type
    ),
    'version',pg_catalog.jsonb_build_object(
      'id',v.id,'versionNo',v.version_no,'title',v.title,
      'metaDescription',v.meta_description,'metaRobots',v.meta_robots,
      'canonicalPath',v.canonical_path,'ogTitle',v.og_title,
      'ogDescription',v.og_description,'ogImageUrl',v.og_image_url,
      'publishedAt',v.published_at
    ),
    'blocks',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',b.id,'type',b.block_type,'sortOrder',b.sort_order,'config',b.config
        ) ORDER BY b.sort_order
      )
      FROM public.site_block b
      WHERE b.tenant_id=s.tenant_id AND b.page_version_id=v.id
    ),'[]'::jsonb)
  )
  FROM public.site_domain d
  JOIN public.site s ON s.tenant_id=d.tenant_id AND s.id=d.site_id
    AND s.status='ACTIVE'
  JOIN public.site_page p ON p.tenant_id=s.tenant_id AND p.site_id=s.id
    AND p.status='ACTIVE'
  JOIN public.site_page_version v ON v.tenant_id=s.tenant_id
    AND v.id=p.published_version_id AND v.page_id=p.id AND v.status='PUBLISHED'
  WHERE d.hostname=lower(trim(trailing '.' from p_hostname))
    AND d.status='ACTIVE'
    AND public.corebiz_tenant_is_operational(s.tenant_id)
    AND p.slug=CASE
      WHEN trim(COALESCE(p_page_slug,'')) IN ('','/') THEN '/'
      ELSE '/'||trim(both '/' from p_page_slug)
    END
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_public_site_routes(
  p_public_slug text
)
RETURNS TABLE(page_slug text,published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT p.slug,v.published_at
  FROM public.site s
  JOIN public.site_page p ON p.tenant_id=s.tenant_id AND p.site_id=s.id
    AND p.status='ACTIVE'
  JOIN public.site_page_version v ON v.tenant_id=p.tenant_id
    AND v.id=p.published_version_id AND v.page_id=p.id AND v.status='PUBLISHED'
  WHERE s.status='ACTIVE'
    AND public.corebiz_tenant_is_operational(s.tenant_id)
    AND s.public_slug=lower(trim(p_public_slug))
  ORDER BY CASE WHEN p.slug='/' THEN 0 ELSE 1 END,p.slug;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_public_site_routes_by_host(
  p_hostname text
)
RETURNS TABLE(page_slug text,published_at timestamptz,public_slug text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT p.slug,v.published_at,s.public_slug
  FROM public.site_domain d
  JOIN public.site s ON s.tenant_id=d.tenant_id AND s.id=d.site_id
    AND s.status='ACTIVE'
  JOIN public.site_page p ON p.tenant_id=s.tenant_id AND p.site_id=s.id
    AND p.status='ACTIVE'
  JOIN public.site_page_version v ON v.tenant_id=p.tenant_id
    AND v.id=p.published_version_id AND v.page_id=p.id AND v.status='PUBLISHED'
  WHERE d.hostname=lower(trim(trailing '.' from p_hostname))
    AND d.status='ACTIVE'
    AND public.corebiz_tenant_is_operational(s.tenant_id)
  ORDER BY CASE WHEN p.slug='/' THEN 0 ELSE 1 END,p.slug;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_public_site_tracker(
  p_public_slug text
)
RETURNS TABLE(tracker_key text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT t.tracker_key
  FROM public.site s
  JOIN public.tracker_site t ON t.tenant_id=s.tenant_id
    AND t.id=s.tracker_site_id AND t.status='ACTIVE'
  WHERE s.status='ACTIVE'
    AND public.corebiz_tenant_is_operational(s.tenant_id)
    AND s.public_slug=lower(trim(p_public_slug))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.corebiz_public_site_page(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_public_site_page_by_host(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_public_site_routes(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_public_site_routes_by_host(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_public_site_tracker(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_public_site_page(text,text) TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_public_site_page_by_host(text,text) TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_public_site_routes(text) TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_public_site_routes_by_host(text) TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_public_site_tracker(text) TO corebiz_app';
  END IF;
END;
$$;

COMMIT;
