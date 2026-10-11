BEGIN;
-- Durable, tenant-owned provider reconciliation, independent of webhook delivery.
-- Claiming is the only cross-tenant operation, narrow and callable only by the
-- dedicated runtime DB role. Work is leased without locking payment rows.
CREATE TABLE commerce_reconcile_task (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 intent_id uuid REFERENCES commerce_payment_intent(id) ON DELETE CASCADE,
 refund_id uuid REFERENCES commerce_refund(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'DUE'
   CHECK (state IN ('DUE','LEASED','DONE','EXHAUSTED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,
 lease_until timestamptz,
 last_error_code text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((intent_id IS NOT NULL AND refund_id IS NULL)
    OR (intent_id IS NULL AND refund_id IS NOT NULL))
);
CREATE UNIQUE INDEX commerce_reconcile_intent_uq ON commerce_reconcile_task(intent_id)
 WHERE intent_id IS NOT NULL;
CREATE UNIQUE INDEX commerce_reconcile_refund_uq ON commerce_reconcile_task(refund_id)
 WHERE refund_id IS NOT NULL;
CREATE INDEX commerce_reconcile_due_idx ON commerce_reconcile_task(next_attempt_at)
 WHERE state IN ('DUE','LEASED');

ALTER TABLE commerce_reconcile_task ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_reconcile_task_tenant ON commerce_reconcile_task
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION corebiz_claim_commerce_reconciliation(p_limit integer)
RETURNS TABLE (
 tenant_id uuid, task_id uuid, intent_id uuid, refund_id uuid,
 lease_id uuid
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
 WITH due AS (
   SELECT t.id FROM public.commerce_reconcile_task t
   WHERE ((t.state='DUE' AND t.next_attempt_at<=now())
       OR (t.state='LEASED' AND t.lease_until<=now()))
     AND t.attempts<60
   ORDER BY t.next_attempt_at,t.id
   FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,0),8)
 )
 UPDATE public.commerce_reconcile_task t
 SET state='LEASED',lease_id=gen_random_uuid(),
     lease_until=now()+interval '90 seconds',
     attempts=t.attempts+1,updated_at=now()
 FROM due WHERE t.id=due.id
 RETURNING t.tenant_id,t.id,t.intent_id,t.refund_id,t.lease_id
$$;
REVOKE ALL ON FUNCTION corebiz_claim_commerce_reconciliation(integer) FROM PUBLIC;

-- Backfill outstanding provider IDs, including already-paid receipts whose
-- fiscal status may still be unresolved. Created without storing credentials.
INSERT INTO commerce_reconcile_task(tenant_id,intent_id)
SELECT tenant_id,id FROM commerce_payment_intent
WHERE provider_payment_id IS NOT NULL
  AND (status IN ('NEW','PENDING')
       OR (status='SUCCEEDED' AND fiscal_status='PENDING'))
ON CONFLICT DO NOTHING;
INSERT INTO commerce_reconcile_task(tenant_id,refund_id)
SELECT tenant_id,id FROM commerce_refund
WHERE provider_refund_id IS NOT NULL
  AND (status IN ('NEW','PENDING')
       OR (status='SUCCEEDED' AND fiscal_status='PENDING'))
ON CONFLICT DO NOTHING;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
  GRANT EXECUTE ON FUNCTION corebiz_claim_commerce_reconciliation(integer) TO corebiz_app;
  GRANT SELECT,INSERT,UPDATE ON commerce_reconcile_task TO corebiz_app;
 END IF;
END $$;
COMMIT;
