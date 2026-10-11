BEGIN;

ALTER TABLE legal_entity
  ADD COLUMN IF NOT EXISTS taxpayer_kind text NOT NULL DEFAULT 'ORGANIZATION',
  ADD COLUMN IF NOT EXISTS ogrn text,
  ADD COLUMN IF NOT EXISTS registered_name text;

ALTER TABLE legal_entity
  DROP CONSTRAINT IF EXISTS legal_entity_taxpayer_kind_ck;

ALTER TABLE legal_entity
  ADD CONSTRAINT legal_entity_taxpayer_kind_ck
  CHECK(taxpayer_kind IN ('ORGANIZATION','IP','INDIVIDUAL'));

ALTER TABLE accounting_tax_profile
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_entity_kind_check,
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_tax_regime_check;

ALTER TABLE accounting_tax_profile
  ADD CONSTRAINT accounting_tax_profile_entity_kind_check
    CHECK(entity_kind IN ('ORGANIZATION','IP','INDIVIDUAL')),
  ADD CONSTRAINT accounting_tax_profile_tax_regime_check
    CHECK(tax_regime IN (
      'NPD','USN_INCOME','USN_INCOME_EXPENSE','OSNO','AUSN','OTHER'
    ));

CREATE TABLE accounting_npd_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  tax_profile_id uuid NOT NULL
    REFERENCES accounting_tax_profile(id) ON DELETE RESTRICT,
  source_type text NOT NULL,
  source_id uuid,
  operation_date timestamptz NOT NULL,
  buyer_kind text NOT NULL
    CHECK(buyer_kind IN ('PERSON','ORGANIZATION','IP')),
  buyer_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  description text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  tax_rate_bps integer NOT NULL
    CHECK(tax_rate_bps IN (400,600)),
  calculated_tax_minor bigint NOT NULL CHECK(calculated_tax_minor>=0),
  fiscal_status text NOT NULL DEFAULT 'DRAFT'
    CHECK(fiscal_status IN (
      'DRAFT','READY','REGISTERED','CANCELLED','ERROR'
    )),
  external_receipt_id text,
  external_receipt_url text,
  registered_at timestamptz,
  cancellation_reason text,
  connector_provider text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,legal_entity_id,source_type,source_id)
);

CREATE INDEX accounting_npd_receipt_period_idx
  ON accounting_npd_receipt(
    tenant_id,legal_entity_id,operation_date,fiscal_status
  );

CREATE TABLE accounting_npd_month (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  tax_profile_id uuid NOT NULL
    REFERENCES accounting_tax_profile(id) ON DELETE RESTRICT,
  period_key text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  person_income_minor bigint NOT NULL DEFAULT 0 CHECK(person_income_minor>=0),
  business_income_minor bigint NOT NULL DEFAULT 0 CHECK(business_income_minor>=0),
  gross_income_minor bigint NOT NULL DEFAULT 0 CHECK(gross_income_minor>=0),
  estimated_tax_minor bigint NOT NULL DEFAULT 0 CHECK(estimated_tax_minor>=0),
  official_tax_minor bigint CHECK(official_tax_minor IS NULL OR official_tax_minor>=0),
  benefit_minor bigint NOT NULL DEFAULT 0 CHECK(benefit_minor>=0),
  payable_minor bigint NOT NULL DEFAULT 0 CHECK(payable_minor>=0),
  source text NOT NULL DEFAULT 'COREBIZ_ESTIMATE'
    CHECK(source IN ('COREBIZ_ESTIMATE','FNS_MY_TAX','MANUAL')),
  status text NOT NULL DEFAULT 'ESTIMATED'
    CHECK(status IN (
      'ESTIMATED','REVIEW_REQUIRED','CONFIRMED','PAID','SUPERSEDED'
    )),
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(date_from<=date_to),
  UNIQUE(tenant_id,legal_entity_id,period_key,status)
);

CREATE INDEX accounting_npd_month_period_idx
  ON accounting_npd_month(
    tenant_id,legal_entity_id,date_from,date_to,status
  );

CREATE OR REPLACE FUNCTION corebiz_accounting_npd_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_kind text;
  v_regime text;
BEGIN
  SELECT p.entity_kind,p.tax_regime
  INTO v_kind,v_regime
  FROM accounting_tax_profile p
  WHERE p.tenant_id=NEW.tenant_id
    AND p.id=NEW.tax_profile_id
    AND p.legal_entity_id=NEW.legal_entity_id;

  IF v_regime IS DISTINCT FROM 'NPD'
     OR v_kind NOT IN ('IP','INDIVIDUAL') THEN
    RAISE EXCEPTION 'ACCOUNTING_NPD_PROFILE_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  IF NEW.tax_rate_bps <> CASE
    WHEN NEW.buyer_kind='PERSON' THEN 400 ELSE 600
  END THEN
    RAISE EXCEPTION 'ACCOUNTING_NPD_RATE_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.calculated_tax_minor <> (
    NEW.amount_minor::numeric*NEW.tax_rate_bps/10000
  )::bigint THEN
    RAISE EXCEPTION 'ACCOUNTING_NPD_TAX_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.fiscal_status='REGISTERED'
     AND (
       NEW.external_receipt_id IS NULL
       OR NEW.registered_at IS NULL
     ) THEN
    RAISE EXCEPTION 'ACCOUNTING_NPD_REGISTRATION_EVIDENCE_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  IF NEW.fiscal_status='CANCELLED'
     AND length(btrim(coalesce(NEW.cancellation_reason,'')))<4 THEN
    RAISE EXCEPTION 'ACCOUNTING_NPD_CANCELLATION_REASON_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_npd_receipt_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_npd_receipt
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_npd_receipt_guard();

ALTER TABLE accounting_npd_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_npd_month ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_npd_receipt_isolation
  ON accounting_npd_receipt
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE POLICY accounting_npd_month_isolation
  ON accounting_npd_month
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

INSERT INTO accounting_regulatory_rule(
  code,version,authority,obligation_type,title,form_code,
  tax_regime,entity_kind,requires_employees,vat_mode,
  cadence,due_rule,source_url,effective_from
) VALUES
(
  'NPD_MONTHLY_PAYMENT',1,'FNS','PAY',
  'Уплатить налог на профессиональный доход',NULL,
  'NPD',NULL,false,'NO_VAT','MONTHLY',
  '{"day":28,"month_offset":1,"period":"previous_month","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn77/taxation/taxes/npd/',
  '2026-01-01'
)
ON CONFLICT(code,version) DO NOTHING;

COMMIT;
