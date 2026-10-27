BEGIN;

-- Commercial file lifecycle for support attachments.
-- A browser never chooses an arbitrary object key: the API reserves a random
-- tenant-bound key, enforces plan quota under the subscription row lock, then
-- verifies the object before promoting it to support_attachment.

INSERT INTO plan_entitlement(plan_id,entitlement_key,entitlement_value)
SELECT p.id,'max_support_storage_bytes',to_jsonb(v.limit_bytes)
FROM billing_plan p
JOIN (
  VALUES
    ('START',104857600::bigint),
    ('BUSINESS',1073741824::bigint),
    ('COMMERCE',5368709120::bigint),
    ('OPERATIONS',10737418240::bigint),
    ('ENTERPRISE',1099511627776::bigint)
) AS v(plan_code,limit_bytes) ON v.plan_code=p.code
ON CONFLICT(plan_id,entitlement_key)
DO UPDATE SET entitlement_value=EXCLUDED.entitlement_value;

CREATE OR REPLACE FUNCTION public.corebiz_plan_bigint_limit(
  p_tenant_id uuid,
  p_entitlement_key text
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(e.entitlement_value)='number'
      THEN (e.entitlement_value #>> '{}')::bigint
    ELSE NULL
  END
  FROM public.tenant_subscription s
  JOIN public.plan_entitlement e
    ON e.plan_id=s.plan_id
   AND e.entitlement_key=p_entitlement_key
  WHERE s.tenant_id=p_tenant_id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.corebiz_plan_bigint_limit(uuid,text) FROM PUBLIC;

CREATE TABLE support_attachment_upload (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES support_ticket(id) ON DELETE CASCADE,
  message_id uuid REFERENCES support_message(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  filename text NOT NULL,
  declared_mime_type text NOT NULL,
  declared_size_bytes bigint NOT NULL
    CHECK(declared_size_bytes>0 AND declared_size_bytes<=26214400),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','VERIFIED','REJECTED','EXPIRED')),
  object_etag text,
  verified_size_bytes bigint,
  verified_mime_type text,
  failure_reason text,
  attachment_id uuid REFERENCES support_attachment(id) ON DELETE SET NULL,
  uploaded_by_membership_id uuid NOT NULL
    REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,object_key)
);

CREATE INDEX support_attachment_upload_pending_idx
  ON support_attachment_upload(tenant_id,expires_at)
  WHERE status='PENDING';

ALTER TABLE support_attachment_upload ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_attachment_upload_isolation
  ON support_attachment_upload
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

ALTER TABLE support_attachment
  ADD COLUMN IF NOT EXISTS object_etag text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS download_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_downloaded_at timestamptz;

-- The runtime role needs ordinary RLS-scoped CRUD only; it never receives
-- storage credentials and cannot bypass tenant isolation.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    GRANT SELECT,INSERT,UPDATE ON support_attachment_upload TO corebiz_app;
    GRANT SELECT,INSERT,UPDATE ON support_attachment TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_plan_bigint_limit(uuid,text)
      TO corebiz_app;
  END IF;
END;
$$;

COMMIT;
