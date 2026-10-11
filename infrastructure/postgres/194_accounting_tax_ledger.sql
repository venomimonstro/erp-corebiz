BEGIN;

ALTER TABLE cash_account
  ADD COLUMN IF NOT EXISTS legal_entity_id uuid
    REFERENCES legal_entity(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cash_account_legal_entity_idx
  ON cash_account(tenant_id,legal_entity_id,status);

DO $$
DECLARE
  t record;
  e uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    SELECT id INTO e
    FROM legal_entity
    WHERE tenant_id=t.id AND status='ACTIVE'
    ORDER BY created_at
    LIMIT 2;

    IF (
      SELECT count(*) FROM legal_entity
      WHERE tenant_id=t.id AND status='ACTIVE'
    )=1 THEN
      UPDATE cash_account
      SET legal_entity_id=e
      WHERE tenant_id=t.id AND legal_entity_id IS NULL;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE accounting_tax_profile
  ADD COLUMN IF NOT EXISTS usn_rate_bps integer,
  ADD COLUMN IF NOT EXISTS usn_minimum_tax_bps integer;

ALTER TABLE accounting_tax_profile
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_usn_rate_ck,
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_usn_minimum_rate_ck;

ALTER TABLE accounting_tax_profile
  ADD CONSTRAINT accounting_tax_profile_usn_rate_ck
    CHECK(usn_rate_bps IS NULL OR usn_rate_bps BETWEEN 1 AND 10000),
  ADD CONSTRAINT accounting_tax_profile_usn_minimum_rate_ck
    CHECK(
      usn_minimum_tax_bps IS NULL OR
      usn_minimum_tax_bps BETWEEN 1 AND 10000
    );

CREATE TABLE accounting_tax_ledger_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES payment(id) ON DELETE RESTRICT,
  recognition_date date NOT NULL,
  direction text NOT NULL CHECK(direction IN ('INCOME','EXPENSE')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  tax_treatment text NOT NULL DEFAULT 'REVIEW_REQUIRED'
    CHECK(tax_treatment IN ('INCLUDED','EXCLUDED','REVIEW_REQUIRED')),
  treatment_reason text,
  source_type text NOT NULL,
  source_id uuid,
  category_code text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(
    tax_treatment='REVIEW_REQUIRED'
    OR (reviewed_by_membership_id IS NOT NULL AND reviewed_at IS NOT NULL)
    OR treatment_reason='AUTO_CUSTOMER_PAYMENT'
  ),
  UNIQUE(tenant_id,legal_entity_id,payment_id)
);

CREATE INDEX accounting_tax_ledger_period_idx
  ON accounting_tax_ledger_item(
    tenant_id,legal_entity_id,recognition_date,tax_treatment,direction
  );

CREATE TABLE accounting_tax_calculation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  tax_profile_id uuid NOT NULL
    REFERENCES accounting_tax_profile(id) ON DELETE RESTRICT,
  obligation_id uuid
    REFERENCES accounting_compliance_obligation(id) ON DELETE SET NULL,
  calculation_type text NOT NULL
    CHECK(calculation_type IN (
      'USN_ADVANCE','USN_ANNUAL','VAT','NDFL_AGENT',
      'INSURANCE_CONTRIBUTIONS','OTHER'
    )),
  period_from date NOT NULL,
  period_to date NOT NULL,
  income_minor bigint NOT NULL DEFAULT 0 CHECK(income_minor>=0),
  expense_minor bigint NOT NULL DEFAULT 0 CHECK(expense_minor>=0),
  tax_base_minor bigint NOT NULL DEFAULT 0 CHECK(tax_base_minor>=0),
  calculated_minor bigint NOT NULL DEFAULT 0 CHECK(calculated_minor>=0),
  reductions_minor bigint NOT NULL DEFAULT 0 CHECK(reductions_minor>=0),
  final_preview_minor bigint NOT NULL DEFAULT 0 CHECK(final_preview_minor>=0),
  confidence text NOT NULL DEFAULT 'REVIEW_REQUIRED'
    CHECK(confidence IN ('PREVIEW','REVIEW_REQUIRED','VERIFIED')),
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  formula_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_to>=period_from),
  CHECK(
    confidence<>'VERIFIED'
    OR (verified_by_membership_id IS NOT NULL AND verified_at IS NOT NULL)
  ),
  UNIQUE(
    tenant_id,legal_entity_id,calculation_type,period_from,period_to
  )
);

CREATE INDEX accounting_tax_calculation_period_idx
  ON accounting_tax_calculation(
    tenant_id,legal_entity_id,period_to DESC,calculation_type
  );

ALTER TABLE accounting_tax_ledger_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_tax_calculation ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_tax_ledger_item_isolation
  ON accounting_tax_ledger_item
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE POLICY accounting_tax_calculation_isolation
  ON accounting_tax_calculation
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE TRIGGER accounting_tax_ledger_item_tenant_refs_v1
BEFORE INSERT OR UPDATE ON accounting_tax_ledger_item
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity',
  'payment_id','payment',
  'reviewed_by_membership_id','tenant_membership'
);

CREATE TRIGGER accounting_tax_calculation_tenant_refs_v1
BEFORE INSERT OR UPDATE ON accounting_tax_calculation
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity',
  'tax_profile_id','accounting_tax_profile',
  'obligation_id','accounting_compliance_obligation',
  'verified_by_membership_id','tenant_membership'
);

COMMIT;
