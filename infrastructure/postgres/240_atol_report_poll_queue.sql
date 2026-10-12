BEGIN;
-- Only already-submitted ATOL documents with a provider UUID may be polled.
-- Creating, resending and retrying POST /sell or /sell_refund are NOT automated.
ALTER TABLE commerce_fiscal_document
  ADD COLUMN poll_after timestamptz,
  ADD COLUMN poll_lease_id uuid,
  ADD COLUMN poll_lease_until timestamptz,
  ADD COLUMN poll_attempts integer NOT NULL DEFAULT 0
    CHECK (poll_attempts BETWEEN 0 AND 100000),
  ADD COLUMN poll_last_error_code text;

UPDATE commerce_fiscal_document
SET poll_after=now()+interval '30 seconds'
WHERE state='WAIT' AND provider_uuid IS NOT NULL;

CREATE INDEX commerce_fiscal_auto_poll_due_idx
ON commerce_fiscal_document(poll_after, id)
WHERE state='WAIT' AND provider_uuid IS NOT NULL AND poll_attempts<60;

-- Small cross-tenant claim capability for the trusted app worker.
-- All follow-up reads and mutations occur in tenant-scoped transactions.
CREATE FUNCTION corebiz_claim_atol_reports(p_limit integer)
RETURNS TABLE (
  tenant_id uuid,site_id uuid,document_id uuid,lease_id uuid
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  WITH due AS (
    SELECT d.id FROM public.commerce_fiscal_document d
    WHERE d.state='WAIT'
      AND d.provider_uuid IS NOT NULL
      AND d.poll_after<=now()
      AND (d.poll_lease_until IS NULL OR d.poll_lease_until<=now())
      AND d.poll_attempts<60
    ORDER BY d.poll_after,d.id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit,0),0),5)
  )
  UPDATE public.commerce_fiscal_document d
  SET poll_lease_id=gen_random_uuid(),
      poll_lease_until=now()+interval '90 seconds',
      poll_attempts=d.poll_attempts+1,
      updated_at=now()
  FROM due WHERE d.id=due.id
  RETURNING d.tenant_id,d.site_id,d.id,d.poll_lease_id
$$;
REVOKE ALL ON FUNCTION corebiz_claim_atol_reports(integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION corebiz_claim_atol_reports(integer) TO corebiz_app;
  END IF;
END $$;
COMMIT;
