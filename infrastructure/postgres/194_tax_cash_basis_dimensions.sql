BEGIN;

ALTER TABLE cash_account
  ADD COLUMN IF NOT EXISTS legal_entity_id uuid;

CREATE INDEX IF NOT EXISTS cash_account_legal_entity_idx
  ON cash_account(tenant_id,legal_entity_id,status);

DO $$
DECLARE
  t record;
  only_entity uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    SELECT min(id)
    INTO only_entity
    FROM legal_entity
    WHERE tenant_id=t.id
      AND status='ACTIVE'
    HAVING count(*)=1;

    IF only_entity IS NOT NULL THEN
      UPDATE cash_account
      SET legal_entity_id=only_entity
      WHERE tenant_id=t.id
        AND legal_entity_id IS NULL;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE cash_account
  ADD CONSTRAINT cash_account_legal_entity_fk
  FOREIGN KEY(legal_entity_id)
  REFERENCES legal_entity(id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION corebiz_cash_account_legal_entity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $
BEGIN
  IF NEW.legal_entity_id IS NOT NULL AND NOT EXISTS(
    SELECT 1
    FROM legal_entity e
    WHERE e.id=NEW.legal_entity_id
      AND e.tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_LEGAL_ENTITY_TENANT_MISMATCH'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS cash_account_legal_entity_guard_v1 ON cash_account;
CREATE TRIGGER cash_account_legal_entity_guard_v1
BEFORE INSERT OR UPDATE OF tenant_id,legal_entity_id
ON cash_account
FOR EACH ROW
EXECUTE FUNCTION corebiz_cash_account_legal_entity_guard();

ALTER TABLE cash_flow_category
  ADD COLUMN IF NOT EXISTS tax_treatment text NOT NULL DEFAULT 'REVIEW';

ALTER TABLE cash_flow_category
  DROP CONSTRAINT IF EXISTS cash_flow_category_tax_treatment_ck;

ALTER TABLE cash_flow_category
  ADD CONSTRAINT cash_flow_category_tax_treatment_ck
  CHECK(tax_treatment IN (
    'TAXABLE_INCOME',
    'INCOME_REVERSAL',
    'DEDUCTIBLE_EXPENSE',
    'EXPENSE_REVERSAL',
    'NON_TAXABLE',
    'NON_DEDUCTIBLE',
    'REVIEW'
  ));

UPDATE cash_flow_category
SET tax_treatment=CASE code
  WHEN 'CUSTOMER_PAYMENT' THEN 'TAXABLE_INCOME'
  WHEN 'CUSTOMER_REFUND' THEN 'INCOME_REVERSAL'
  ELSE tax_treatment
END
WHERE code IN ('CUSTOMER_PAYMENT','CUSTOMER_REFUND');

ALTER TABLE accounting_tax_profile
  ADD COLUMN IF NOT EXISTS usn_rate_bps integer,
  ADD COLUMN IF NOT EXISTS usn_min_rate_bps integer;

ALTER TABLE accounting_tax_profile
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_usn_rate_bps_ck,
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_usn_min_rate_bps_ck;

ALTER TABLE accounting_tax_profile
  ADD CONSTRAINT accounting_tax_profile_usn_rate_bps_ck
    CHECK(usn_rate_bps IS NULL OR usn_rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT accounting_tax_profile_usn_min_rate_bps_ck
    CHECK(usn_min_rate_bps IS NULL OR usn_min_rate_bps BETWEEN 0 AND 10000);

UPDATE accounting_tax_profile
SET
  usn_rate_bps=CASE
    WHEN tax_regime='USN_INCOME' THEN coalesce(usn_rate_bps,600)
    WHEN tax_regime='USN_INCOME_EXPENSE' THEN coalesce(usn_rate_bps,1500)
    ELSE usn_rate_bps
  END,
  usn_min_rate_bps=CASE
    WHEN tax_regime='USN_INCOME_EXPENSE' THEN coalesce(usn_min_rate_bps,100)
    ELSE usn_min_rate_bps
  END
WHERE tax_regime IN ('USN_INCOME','USN_INCOME_EXPENSE');

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'accounting.compliance.calculate','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
