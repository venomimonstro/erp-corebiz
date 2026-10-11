BEGIN;

-- A configured shop may be a draft. Never expose its catalog or let visitors
-- create orders via a guessed public_slug until the owner publishes a homepage.
-- Keep SECURITY DEFINER and RLS boundaries; do not accept tenant input.
CREATE OR REPLACE FUNCTION corebiz_resolve_public_storefront(
  p_public_slug text
)
RETURNS TABLE(
  site_id uuid,
  tenant_id uuid,
  responsible_membership_id uuid,
  currency char(3)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id,s.tenant_id,c.responsible_membership_id,c.currency
  FROM site s
  JOIN storefront_config c
    ON c.tenant_id=s.tenant_id AND c.site_id=s.id
  WHERE s.public_slug=lower(trim(p_public_slug))
    AND s.status='ACTIVE'
    AND c.enabled=true
    AND EXISTS (
      SELECT 1
      FROM site_page p
      JOIN site_page_version v
        ON v.id=p.published_version_id
       AND v.tenant_id=p.tenant_id
       AND v.page_id=p.id
      WHERE p.tenant_id=s.tenant_id
        AND p.site_id=s.id
        AND p.slug='/'
        AND p.status='ACTIVE'
        AND v.status='PUBLISHED'
    )
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_public_storefront(text) FROM PUBLIC;

COMMIT;
