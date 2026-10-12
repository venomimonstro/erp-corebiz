BEGIN;
-- A status poll may be repeated, but a fiscal document POST must NEVER be
-- repeated on a timeout. This queue contains only documents with a known
-- provider UUID; UNKNOWN/no UUID still requires operator reconciliation.
CREATE TABLE commerce_fiscal_reconcile_task(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES commerce_fiscal_document(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'DUE'
    CHECK(state IN ('DUE','LEASED','DONE','EXHAUSTED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,document_id)
);
CREATE INDEX commerce_fiscal_reconcile_due_idx
 ON commerce_fiscal_reconcile_task(next_attempt_at)
 WHERE state IN ('DUE','LEASED');
ALTER TABLE commerce_fiscal_reconcile_task ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_fiscal_reconcile_tenant ON commerce_fiscal_reconcile_task
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION corebiz_claim_atol_fiscal_reconciliation(p_limit integer)
RETURNS TABLE(
  tenant_id uuid, task_id uuid, document_id uuid, site_id uuid,
  lease_id uuid
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 WITH due AS (
   SELECT t.id
   FROM public.commerce_fiscal_reconcile_task t
   JOIN public.commerce_fiscal_document d
     ON d.tenant_id=t.tenant_id AND d.id=t.document_id
   WHERE ((t.state='DUE' AND t.next_attempt_at<=now())
      OR (t.state='LEASED' AND t.lease_until<=now()))
     AND t.attempts < 80
     AND d.provider_uuid IS NOT NULL
     AND d.state IN ('WAIT','UNKNOWN','SENDING')
   ORDER BY t.next_attempt_at,t.id
   FOR UPDATE OF t SKIP LOCKED
   LIMIT LEAST(GREATEST(p_limit,0),5)
 )
 UPDATE public.commerce_fiscal_reconcile_task t
 SET state='LEASED',lease_id=gen_random_uuid(),
     lease_until=now()+interval '120 seconds',
     attempts=t.attempts+1,updated_at=now()
 FROM due,public.commerce_fiscal_document d
 WHERE t.id=due.id AND d.tenant_id=t.tenant_id
   AND d.id=t.document_id
 RETURNING t.tenant_id,t.id,t.document_id,d.site_id,t.lease_id
$$;
REVOKE ALL ON FUNCTION corebiz_claim_atol_fiscal_reconciliation(integer) FROM PUBLIC;
INSERT INTO commerce_fiscal_reconcile_task(tenant_id,document_id)
SELECT tenant_id,id
FROM commerce_fiscal_document
WHERE provider_uuid IS NOT NULL
  AND state IN ('WAIT','UNKNOWN','SENDING')
ON CONFLICT(tenant_id,document_id) DO NOTHING;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
   GRANT SELECT,INSERT,UPDATE ON commerce_fiscal_reconcile_task TO corebiz_app;
   GRANT EXECUTE ON FUNCTION corebiz_claim_atol_fiscal_reconciliation(integer)
     TO corebiz_app;
 END IF;
END $$;
COMMIT;
