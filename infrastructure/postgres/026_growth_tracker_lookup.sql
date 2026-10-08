BEGIN;

CREATE OR REPLACE FUNCTION corebiz_tracker_site_lookup(p_tracker_key text)
RETURNS TABLE(
  site_id uuid,
  tenant_id uuid,
  allowed_domains jsonb,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, tracker_site.tenant_id, allowed_domains, tracker_site.status
  FROM tracker_site
  WHERE tracker_key = p_tracker_key
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_tracker_site_lookup(text) FROM PUBLIC;

COMMIT;
