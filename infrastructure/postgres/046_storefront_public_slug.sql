BEGIN;

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
  SELECT
    s.id,
    s.tenant_id,
    c.responsible_membership_id,
    c.currency
  FROM site s
  JOIN storefront_config c
    ON c.tenant_id=s.tenant_id
   AND c.site_id=s.id
  WHERE s.public_slug=lower(trim(p_public_slug))
    AND s.status='ACTIVE'
    AND c.enabled=true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_public_storefront(text) FROM PUBLIC;

CREATE INDEX IF NOT EXISTS storefront_cart_expiry_idx
  ON storefront_cart(status,expires_at)
  WHERE status='OPEN';

COMMIT;
