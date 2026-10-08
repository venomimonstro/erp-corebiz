BEGIN;

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS tracker_site_id uuid
  REFERENCES tracker_site(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS site_tracker_site_unique_idx
  ON site(tracker_site_id)
  WHERE tracker_site_id IS NOT NULL;

DO $$
DECLARE
  r record;
  v_tracker_id uuid;
  v_domains jsonb;
BEGIN
  FOR r IN
    SELECT
      s.id AS site_id,
      s.tenant_id,
      s.name,
      s.created_by_membership_id
    FROM site s
    WHERE s.tracker_site_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM site_domain d
        WHERE d.tenant_id=s.tenant_id
          AND d.site_id=s.id
          AND d.status='ACTIVE'
      )
  LOOP
    SELECT COALESCE(
      jsonb_agg(d.hostname ORDER BY d.hostname),
      '[]'::jsonb
    )
    INTO v_domains
    FROM site_domain d
    WHERE d.tenant_id=r.tenant_id
      AND d.site_id=r.site_id
      AND d.status='ACTIVE';

    INSERT INTO tracker_site(
      tenant_id,
      name,
      tracker_key,
      allowed_domains,
      created_by_membership_id
    )
    VALUES (
      r.tenant_id,
      'Сайт: ' || r.name,
      'cb_' || replace(gen_random_uuid()::text,'-',''),
      v_domains,
      r.created_by_membership_id
    )
    RETURNING id INTO v_tracker_id;

    UPDATE site
    SET tracker_site_id=v_tracker_id,
        updated_at=now()
    WHERE id=r.site_id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_public_site_tracker(
  p_public_slug text
)
RETURNS TABLE(
  tracker_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.tracker_key
  FROM site s
  JOIN tracker_site t
    ON t.tenant_id=s.tenant_id
   AND t.id=s.tracker_site_id
   AND t.status='ACTIVE'
  WHERE s.status='ACTIVE'
    AND s.public_slug=lower(trim(p_public_slug))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_public_site_tracker(text) FROM PUBLIC;

COMMIT;
