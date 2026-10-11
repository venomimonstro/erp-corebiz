BEGIN;

ALTER TABLE accounting_tax_profile
  ADD COLUMN IF NOT EXISTS usn_rate_bps integer,
  ADD COLUMN IF NOT EXISTS usn_min_tax_bps integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS auto_classification boolean NOT NULL DEFAULT true;

ALTER TABLE accounting_tax_profile
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_usn_rate_ck,
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_usn_min_tax_ck;

ALTER TABLE accounting_tax_profile
  ADD CONSTRAINT accounting_tax_profile_usn_rate_ck
    CHECK(usn_rate_bps IS NULL OR usn_rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT accounting_tax_profile_usn_min_tax_ck
    CHECK(usn_min_tax_bps BETWEEN 0 AND 10000);

CREATE TABLE accounting_tax_payment_classification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payment(id) ON DELETE CASCADE,
  treatment text NOT NULL
    CHECK(treatment IN (
      'TAXABLE_INCOME','DEDUCTIBLE_EXPENSE','NON_DEDUCTIBLE_EXPENSE',
      'EXCLUDED','REVIEW_REQUIRED'
    )),
  source text NOT NULL
    CHECK(source IN ('AUTO_RULE','MANUAL','IMPORT')),
  confidence integer NOT NULL DEFAULT 100
    CHECK(confidence BETWEEN 0 AND 100),
  reason text,
  rule_code text,
  classified_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  classified_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,legal_entity_id,payment_id)
);

CREATE INDEX accounting_tax_payment_classification_treatment_idx
  ON accounting_tax_payment_classification(
    tenant_id,legal_entity_id,treatment,classified_at
  );

ALTER TABLE accounting_tax_payment_classification ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounting_tax_payment_classification_isolation
  ON accounting_tax_payment_classification
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE OR REPLACE FUNCTION corebiz_accounting_tax_payment_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM payment p
    WHERE p.tenant_id=NEW.tenant_id
      AND p.id=NEW.payment_id
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_TAX_PAYMENT_MISSING'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1
    FROM legal_entity l
    WHERE l.tenant_id=NEW.tenant_id
      AND l.id=NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_TAX_PAYMENT_LEGAL_ENTITY_MISMATCH'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_tax_payment_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_tax_payment_classification
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_tax_payment_guard();

COMMIT;
