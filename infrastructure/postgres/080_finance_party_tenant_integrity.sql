-- Sprint 50b: tenant integrity of Party on financial obligations and payments.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_finance_party_tenant()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.party_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM party p
   WHERE p.id=NEW.party_id AND p.tenant_id=NEW.tenant_id
 ) THEN
   RAISE EXCEPTION 'Financial party belongs to another tenant'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM financial_obligation o
  LEFT JOIN party p ON p.id=o.party_id AND p.tenant_id=o.tenant_id
  WHERE o.party_id IS NOT NULL AND p.id IS NULL
 ) OR EXISTS (
  SELECT 1 FROM payment x
  LEFT JOIN party p ON p.id=x.party_id AND p.tenant_id=x.tenant_id
  WHERE x.party_id IS NOT NULL AND p.id IS NULL
 ) THEN
   RAISE EXCEPTION 'Historical finance party tenant mismatch; reconcile first';
 END IF;
END;
$$;

CREATE TRIGGER financial_obligation_party_tenant_v1
BEFORE INSERT OR UPDATE OF tenant_id,party_id
ON financial_obligation FOR EACH ROW
EXECUTE FUNCTION corebiz_validate_finance_party_tenant();

CREATE TRIGGER payment_party_tenant_v1
BEFORE INSERT OR UPDATE OF tenant_id,party_id
ON payment FOR EACH ROW
EXECUTE FUNCTION corebiz_validate_finance_party_tenant();

COMMIT;
