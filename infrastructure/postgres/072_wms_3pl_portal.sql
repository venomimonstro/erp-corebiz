BEGIN;

CREATE TABLE wms_3pl_portal_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE CASCADE,
  label text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
  expires_at timestamptz,
  last_used_at timestamptz,
  access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  revoked_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);

CREATE INDEX wms_3pl_portal_owner_idx
  ON wms_3pl_portal_access(tenant_id,owner_id,status,created_at DESC);

ALTER TABLE wms_3pl_portal_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_3pl_portal_access_isolation
  ON wms_3pl_portal_access
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION corebiz_resolve_3pl_portal_access(
  p_token_hash text
)
RETURNS TABLE(
  access_id uuid,
  tenant_id uuid,
  owner_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  UPDATE wms_3pl_portal_access a
  SET
    status=CASE
      WHEN a.expires_at IS NOT NULL AND a.expires_at <= now()
        THEN 'EXPIRED'
      ELSE a.status
    END,
    last_used_at=CASE
      WHEN a.status='ACTIVE'
       AND (a.expires_at IS NULL OR a.expires_at > now())
        THEN now()
      ELSE a.last_used_at
    END,
    access_count=CASE
      WHEN a.status='ACTIVE'
       AND (a.expires_at IS NULL OR a.expires_at > now())
        THEN a.access_count+1
      ELSE a.access_count
    END
  WHERE a.token_hash=p_token_hash;

  RETURN QUERY
  SELECT a.id,a.tenant_id,a.owner_id
  FROM wms_3pl_portal_access a
  JOIN inventory_owner o
    ON o.tenant_id=a.tenant_id
   AND o.id=a.owner_id
   AND o.owner_type='CLIENT'
   AND o.status='ACTIVE'
  WHERE a.token_hash=p_token_hash
    AND a.status='ACTIVE'
    AND (a.expires_at IS NULL OR a.expires_at > now())
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_3pl_portal_access(text) FROM PUBLIC;

COMMIT;
