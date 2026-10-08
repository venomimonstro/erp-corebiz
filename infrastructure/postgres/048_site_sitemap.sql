BEGIN;

CREATE OR REPLACE FUNCTION corebiz_public_site_routes(
  p_public_slug text
)
RETURNS TABLE(
  page_slug text,
  published_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.slug,v.published_at
  FROM site s
  JOIN site_page p
    ON p.tenant_id=s.tenant_id
   AND p.site_id=s.id
   AND p.status='ACTIVE'
  JOIN site_page_version v
    ON v.tenant_id=p.tenant_id
   AND v.id=p.published_version_id
   AND v.page_id=p.id
   AND v.status='PUBLISHED'
  WHERE s.status='ACTIVE'
    AND s.public_slug=lower(trim(p_public_slug))
  ORDER BY
    CASE WHEN p.slug='/' THEN 0 ELSE 1 END,
    p.slug;
$$;

CREATE OR REPLACE FUNCTION corebiz_public_site_routes_by_host(
  p_hostname text
)
RETURNS TABLE(
  page_slug text,
  published_at timestamptz,
  public_slug text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.slug,v.published_at,s.public_slug
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
    ON v.tenant_id=p.tenant_id
   AND v.id=p.published_version_id
   AND v.page_id=p.id
   AND v.status='PUBLISHED'
  WHERE d.hostname=lower(trim(trailing '.' from p_hostname))
    AND d.status='ACTIVE'
  ORDER BY
    CASE WHEN p.slug='/' THEN 0 ELSE 1 END,
    p.slug;
$$;

REVOKE ALL ON FUNCTION corebiz_public_site_routes(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION corebiz_public_site_routes_by_host(text) FROM PUBLIC;

COMMIT;
