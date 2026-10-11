BEGIN;

-- Supplemental auditable tax ledger. Core tax calculations are owned by
-- 193_accounting_tax_automation.sql; this migration must not redefine them.

CREATE TABLE IF NOT EXISTS accounting_tax_ledger_item (
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

CREATE INDEX IF NOT EXISTS accounting_tax_ledger_period_idx
  ON accounting_tax_ledger_item(
    tenant_id,legal_entity_id,recognition_date,tax_treatment,direction
  );

ALTER TABLE accounting_tax_ledger_item ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounting_tax_ledger_item_isolation
  ON accounting_tax_ledger_item;
CREATE POLICY accounting_tax_ledger_item_isolation
  ON accounting_tax_ledger_item
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

DROP TRIGGER IF EXISTS accounting_tax_ledger_item_tenant_refs_v1
  ON accounting_tax_ledger_item;
CREATE TRIGGER accounting_tax_ledger_item_tenant_refs_v1
BEFORE INSERT OR UPDATE ON accounting_tax_ledger_item
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity',
  'payment_id','payment',
  'reviewed_by_membership_id','tenant_membership'
);

COMMIT;
