BEGIN;

CREATE OR REPLACE FUNCTION corebiz_resolve_tracker_site(p_tracker_key text)
RETURNS TABLE(
  site_id uuid,
  tenant_id uuid,
  allowed_domains jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.tenant_id, s.allowed_domains
  FROM tracker_site s
  WHERE s.tracker_key = p_tracker_key
    AND s.status = 'ACTIVE'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_tracker_site(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tracker_summary(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(
  visitors bigint,
  sessions bigint,
  pageviews bigint,
  events bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(DISTINCT v.id) AS visitors,
    count(DISTINCT s.id) AS sessions,
    count(e.id) FILTER (WHERE e.event_name = 'page_view') AS pageviews,
    count(e.id) AS events
  FROM marketing_visitor v
  LEFT JOIN marketing_session s
    ON s.tenant_id = v.tenant_id
   AND s.visitor_id = v.id
   AND s.started_at >= p_from
   AND s.started_at < p_to
  LEFT JOIN marketing_event e
    ON e.tenant_id = v.tenant_id
   AND e.visitor_id = v.id
   AND e.occurred_at >= p_from
   AND e.occurred_at < p_to
  WHERE v.tenant_id = p_tenant_id;
$$;

REVOKE ALL ON FUNCTION corebiz_tracker_summary(uuid,timestamptz,timestamptz) FROM PUBLIC;

COMMIT;
