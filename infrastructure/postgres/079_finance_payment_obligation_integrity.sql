-- Sprint 50: prevent attaching an unrelated payment to a receivable/payable.
-- Existing data is checked before enabling fail-closed writes.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_payment_obligation_dimensions()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.obligation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM financial_obligation o
    WHERE o.id=NEW.obligation_id
      AND o.tenant_id=NEW.tenant_id
      AND o.currency=NEW.currency
      AND (
        NEW.party_id IS NULL OR o.party_id IS NULL OR
        NEW.party_id=o.party_id
      )
  ) THEN
    RAISE EXCEPTION 'Payment obligation tenant, currency or party mismatch'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cash_account a
    WHERE a.id=NEW.cash_account_id
      AND a.tenant_id=NEW.tenant_id
      AND a.currency=NEW.currency
  ) THEN
    RAISE EXCEPTION 'Payment cash account tenant or currency mismatch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM payment p
  LEFT JOIN cash_account a
    ON a.id=p.cash_account_id AND a.tenant_id=p.tenant_id
    AND a.currency=p.currency
  LEFT JOIN financial_obligation o
    ON o.id=p.obligation_id AND o.tenant_id=p.tenant_id
    AND o.currency=p.currency
    AND (p.party_id IS NULL OR o.party_id IS NULL OR p.party_id=o.party_id)
  WHERE a.id IS NULL OR (p.obligation_id IS NOT NULL AND o.id IS NULL)
 ) THEN
  RAISE EXCEPTION 'Existing payment dimensions inconsistent; reconcile before migration';
 END IF;
END;
$$;

CREATE TRIGGER payment_obligation_dimensions_v1
BEFORE INSERT OR UPDATE OF tenant_id,cash_account_id,obligation_id,party_id,currency
ON payment FOR EACH ROW
EXECUTE FUNCTION corebiz_validate_payment_obligation_dimensions();

COMMIT;
