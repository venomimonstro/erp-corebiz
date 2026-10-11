BEGIN;

ALTER TABLE accounting_tax_profile
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_vat_mode_check;

UPDATE accounting_tax_profile
SET vat_mode='VAT_22'
WHERE vat_mode='VAT_20';

ALTER TABLE accounting_tax_profile
  ADD CONSTRAINT accounting_tax_profile_vat_mode_check
  CHECK(vat_mode IN (
    'NO_VAT','VAT_5','VAT_7','VAT_22','VAT_MIXED'
  ));

CREATE TABLE accounting_tax_calculation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  tax_profile_id uuid NOT NULL
    REFERENCES accounting_tax_profile(id) ON DELETE RESTRICT,
  tax_code text NOT NULL,
  period_key text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  taxable_income_minor bigint NOT NULL DEFAULT 0,
  deductible_expense_minor bigint NOT NULL DEFAULT 0,
  taxable_base_minor bigint NOT NULL DEFAULT 0,
  calculated_tax_minor bigint NOT NULL DEFAULT 0,
  advances_minor bigint NOT NULL DEFAULT 0,
  tax_due_minor bigint NOT NULL DEFAULT 0,
  calculation_method text NOT NULL,
  rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','REVIEW_REQUIRED','CONFIRMED','SUPERSEDED')),
  confirmed_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(date_from<=date_to),
  CHECK(taxable_income_minor>=0),
  CHECK(deductible_expense_minor>=0),
  CHECK(taxable_base_minor>=0),
  CHECK(calculated_tax_minor>=0),
  CHECK(advances_minor>=0),
  CHECK(tax_due_minor>=0),
  CHECK(
    status<>'CONFIRMED'
    OR (
      confirmed_by_membership_id IS NOT NULL
      AND confirmed_at IS NOT NULL
    )
  ),
  UNIQUE(tenant_id,legal_entity_id,tax_code,period_key,status)
);

CREATE INDEX accounting_tax_calculation_lookup_idx
  ON accounting_tax_calculation(
    tenant_id,legal_entity_id,tax_code,date_from,date_to,status
  );

CREATE TABLE accounting_filing_package (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL
    REFERENCES accounting_compliance_obligation(id) ON DELETE RESTRICT,
  form_code text NOT NULL,
  format_version text NOT NULL,
  payload_format text NOT NULL
    CHECK(payload_format IN ('XML','JSON','PDF','ZIP')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum_sha256 text,
  validation_status text NOT NULL DEFAULT 'NOT_VALIDATED'
    CHECK(validation_status IN (
      'NOT_VALIDATED','VALID','INVALID','REVIEW_REQUIRED'
    )),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  signature_status text NOT NULL DEFAULT 'UNSIGNED'
    CHECK(signature_status IN (
      'UNSIGNED','SIGNATURE_REQUIRED','SIGNED','SIGNATURE_EXPIRED'
    )),
  signed_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  signed_at timestamptz,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN (
      'DRAFT','READY_FOR_REVIEW','APPROVED','QUEUED',
      'SUBMITTED','ACCEPTED','REJECTED','SUPERSEDED'
    )),
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,obligation_id,format_version)
);

CREATE TABLE accounting_submission_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  filing_package_id uuid NOT NULL
    REFERENCES accounting_filing_package(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL
    REFERENCES accounting_reporting_connector(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK(status IN (
      'QUEUED','SENDING','SUBMITTED','ACCEPTED','REJECTED',
      'RETRYABLE_ERROR','PERMANENT_ERROR','CANCELLED'
    )),
  provider_reference text,
  provider_status text,
  request_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  attempted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,idempotency_key)
);

CREATE INDEX accounting_submission_status_idx
  ON accounting_submission_attempt(
    tenant_id,status,created_at
  );

CREATE TABLE accounting_ens_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  balance_minor bigint NOT NULL DEFAULT 0,
  upcoming_minor bigint NOT NULL DEFAULT 0,
  overdue_minor bigint NOT NULL DEFAULT 0,
  source text NOT NULL
    CHECK(source IN ('MANUAL','FNS_CONNECTOR','IMPORT')),
  external_reference text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL
);

CREATE INDEX accounting_ens_snapshot_latest_idx
  ON accounting_ens_snapshot(
    tenant_id,legal_entity_id,snapshot_at DESC
  );

CREATE OR REPLACE FUNCTION corebiz_accounting_tax_calculation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM accounting_tax_profile p
    WHERE p.tenant_id=NEW.tenant_id
      AND p.id=NEW.tax_profile_id
      AND p.legal_entity_id=NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_TAX_CALCULATION_PROFILE_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE'
     AND OLD.status='CONFIRMED'
     AND (
       to_jsonb(OLD)-'status'-'updated_at'
     ) IS DISTINCT FROM (
       to_jsonb(NEW)-'status'-'updated_at'
     ) THEN
    RAISE EXCEPTION 'ACCOUNTING_CONFIRMED_TAX_CALCULATION_IMMUTABLE'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_tax_calculation_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_tax_calculation
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_tax_calculation_guard();

CREATE OR REPLACE FUNCTION corebiz_accounting_filing_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM accounting_compliance_obligation o
    WHERE o.tenant_id=NEW.tenant_id
      AND o.id=NEW.obligation_id
      AND o.legal_entity_id=NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_FILING_OBLIGATION_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.status IN ('APPROVED','QUEUED','SUBMITTED','ACCEPTED')
     AND NEW.validation_status<>'VALID' THEN
    RAISE EXCEPTION 'ACCOUNTING_FILING_VALIDATION_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  IF NEW.status IN ('QUEUED','SUBMITTED','ACCEPTED')
     AND NEW.signature_status<>'SIGNED' THEN
    RAISE EXCEPTION 'ACCOUNTING_FILING_SIGNATURE_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_filing_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_filing_package
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_filing_guard();

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'accounting_tax_calculation',
    'accounting_filing_package',
    'accounting_submission_attempt',
    'accounting_ens_snapshot'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I
       USING (
         tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid
       )
       WITH CHECK (
         tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid
       )',
      tbl||'_isolation',tbl
    );
  END LOOP;
END;
$$;

UPDATE accounting_regulatory_rule
SET status='RETIRED',effective_to='2025-12-31'
WHERE code='VAT_DECLARATION'
  AND version=1
  AND effective_to IS NULL;

INSERT INTO accounting_regulatory_rule(
  code,version,authority,obligation_type,title,form_code,
  tax_regime,entity_kind,requires_employees,vat_mode,
  cadence,due_rule,source_url,effective_from
) VALUES
(
  'VAT_DECLARATION',2,'FNS','FILE',
  'Декларация по НДС','VAT_DECLARATION',
  NULL,NULL,NULL,'VAT_REQUIRED','QUARTERLY',
  '{"day":25,"month_offset":1,"period":"previous_quarter","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn77/taxation/taxes/nds/',
  '2026-01-01'
),
(
  'VAT_PAYMENT',1,'FNS','PAY',
  'Уплата НДС','VAT_PAYMENT',
  NULL,NULL,NULL,'VAT_REQUIRED','MONTHLY',
  '{"day":28,"installment":"one_third","period":"previous_quarter","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn77/taxation/taxes/nds/',
  '2026-01-01'
),
(
  'NDFL_NOTIFICATION_1_22',1,'FNS','NOTIFY',
  'Уведомление НДФЛ за период 1–22 число','ENS_NOTIFICATION',
  NULL,NULL,true,NULL,'SEMI_MONTHLY',
  '{"day":25,"segment":"1_22","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/',
  '2026-01-01'
),
(
  'NDFL_NOTIFICATION_23_END',1,'FNS','NOTIFY',
  'Уведомление НДФЛ за период 23 число–конец месяца','ENS_NOTIFICATION',
  NULL,NULL,true,NULL,'SEMI_MONTHLY',
  '{"day":3,"month_offset":1,"segment":"23_end","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/',
  '2026-01-01'
),
(
  'RSV_QUARTER',1,'FNS','FILE',
  'Расчёт по страховым взносам','RSV',
  NULL,NULL,true,NULL,'QUARTERLY',
  '{"day":25,"month_offset":1,"period":"previous_quarter","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/',
  '2026-01-01'
),
(
  'NDFL_6_QUARTER',1,'FNS','FILE',
  'Расчёт 6-НДФЛ','6NDFL',
  NULL,NULL,true,NULL,'QUARTERLY',
  '{"day":25,"month_offset":1,"period":"previous_quarter","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/',
  '2026-01-01'
);

COMMIT;
