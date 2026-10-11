BEGIN;

-- Supplemental cash-flow tax semantics only.
-- Legal-entity ownership of cash accounts is canonical in
-- 196_cash_account_legal_entity.sql.
-- USN rates are canonical in
-- 194_accounting_tax_payment_classification.sql.

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

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'accounting.compliance.calculate','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
