BEGIN;
-- Prior worker directly selected all tenants' events without an RLS policy.
-- Claims are now a narrowly scoped SECURITY DEFINER operation. Actions and
-- status updates remain subject to the claimed tenant's normal RLS context.
ALTER TABLE domain_event_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY domain_event_outbox_tenant_isolation
  ON domain_event_outbox
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE INDEX domain_event_outbox_abandoned_idx
  ON domain_event_outbox(locked_at,id)
  WHERE status='PROCESSING' AND attempts<5;

CREATE FUNCTION corebiz_claim_domain_event()
RETURNS TABLE(
  id uuid,tenant_id uuid,event_name text,entity_type text,entity_id uuid,
  actor_user_id uuid,actor_membership_id uuid,payload jsonb,depth integer,
  attempts integer,locked_at timestamptz
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  WITH chosen AS (
    SELECT e.id
    FROM public.domain_event_outbox e
    WHERE e.attempts<5 AND (
      (e.status IN ('PENDING','FAILED') AND e.next_attempt_at<=now())
      OR (e.status='PROCESSING' AND (
        e.locked_at IS NULL OR
        e.locked_at<now()-interval '15 minutes'
      ))
    )
    ORDER BY e.created_at,e.id
    FOR UPDATE OF e SKIP LOCKED LIMIT 1
  )
  UPDATE public.domain_event_outbox e
  SET status='PROCESSING',locked_at=now(),attempts=e.attempts+1
  FROM chosen WHERE e.id=chosen.id
  RETURNING e.id,e.tenant_id,e.event_name,e.entity_type,e.entity_id,
    e.actor_user_id,e.actor_membership_id,e.payload,e.depth,
    e.attempts,e.locked_at
$$;
REVOKE ALL ON FUNCTION corebiz_claim_domain_event() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION corebiz_claim_domain_event() TO corebiz_app;
    GRANT SELECT,INSERT,UPDATE ON domain_event_outbox TO corebiz_app;
  END IF;
END $$;
COMMIT;
