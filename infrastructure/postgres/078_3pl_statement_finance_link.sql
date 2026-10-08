BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_statement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM warehouse_3pl_contract c
    WHERE c.id=NEW.contract_id
      AND c.tenant_id=NEW.tenant_id
      AND c.warehouse_id=NEW.warehouse_id
      AND c.owner_id=NEW.owner_id
  ) THEN
    RAISE EXCEPTION '3PL statement contract dimensions mismatch'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' AND OLD.status='FINALIZED' THEN
    IF OLD.finance_invoice_id IS NOT NULL
       AND NEW.finance_invoice_id IS DISTINCT FROM OLD.finance_invoice_id
    THEN
      RAISE EXCEPTION 'Finalized 3PL statement finance link is immutable'
        USING ERRCODE='23514';
    END IF;

    IF (
      to_jsonb(NEW)
        - ARRAY['finance_invoice_id','finance_handed_off_at','updated_at']::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD)
        - ARRAY['finance_invoice_id','finance_handed_off_at','updated_at']::text[]
    ) THEN
      RAISE EXCEPTION 'Finalized 3PL statement is immutable'
        USING ERRCODE='23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
