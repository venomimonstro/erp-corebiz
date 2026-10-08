BEGIN;

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS channel_connection_id uuid
  REFERENCES channel_connection(id) ON DELETE SET NULL;

DO $$
DECLARE
  r record;
  v_connection_id uuid;
BEGIN
  FOR r IN
    SELECT
      s.id AS site_id,
      s.tenant_id,
      s.name,
      s.created_by_membership_id
    FROM site s
    WHERE s.channel_connection_id IS NULL
  LOOP
    INSERT INTO channel_connection(
      tenant_id,
      provider,
      name,
      status,
      config,
      created_by_membership_id
    )
    VALUES (
      r.tenant_id,
      'OWN_SITE',
      'Сайт: ' || r.name,
      'ACTIVE',
      jsonb_build_object('siteId', r.site_id, 'internal', true),
      r.created_by_membership_id
    )
    RETURNING id INTO v_connection_id;

    UPDATE site
    SET channel_connection_id=v_connection_id,
        updated_at=now()
    WHERE id=r.site_id;
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS site_channel_connection_unique_idx
  ON site(channel_connection_id)
  WHERE channel_connection_id IS NOT NULL;

CREATE OR REPLACE FUNCTION corebiz_resolve_site_store(
  p_public_slug text
)
RETURNS TABLE(
  tenant_id uuid,
  site_id uuid,
  channel_connection_id uuid,
  created_by_membership_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    s.tenant_id,
    s.id,
    s.channel_connection_id,
    s.created_by_membership_id
  FROM site s
  JOIN channel_connection c
    ON c.tenant_id=s.tenant_id
   AND c.id=s.channel_connection_id
   AND c.provider='OWN_SITE'
   AND c.status='ACTIVE'
  WHERE s.status='ACTIVE'
    AND s.public_slug=lower(trim(p_public_slug))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_site_store(text) FROM PUBLIC;

COMMIT;
