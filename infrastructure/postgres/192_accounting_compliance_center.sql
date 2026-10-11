BEGIN;

CREATE TABLE accounting_tax_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  entity_kind text NOT NULL
    CHECK(entity_kind IN ('ORGANIZATION','IP')),
  tax_regime text NOT NULL
    CHECK(tax_regime IN (
      'USN_INCOME','USN_INCOME_EXPENSE','OSNO','AUSN','OTHER'
    )),
  vat_mode text NOT NULL DEFAULT 'NO_VAT'
    CHECK(vat_mode IN ('NO_VAT','VAT_5','VAT_7','VAT_20','VAT_MIXED')),
  has_employees boolean NOT NULL DEFAULT false,
  tax_region_code text,
  tax_office_code text,
  ens_enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE','ARCHIVED')),
  effective_from date NOT NULL DEFAULT current_date,
  effective_to date,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  UNIQUE(tenant_id,legal_entity_id,effective_from)
);

CREATE INDEX accounting_tax_profile_lookup_idx
  ON accounting_tax_profile(
    tenant_id,legal_entity_id,status,effective_from DESC
  );

CREATE TABLE accounting_regulatory_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  authority text NOT NULL CHECK(authority IN ('FNS','SFR','ROSSTAT','OTHER')),
  obligation_type text NOT NULL
    CHECK(obligation_type IN ('FILE','PAY','NOTIFY','RECONCILE')),
  title text NOT NULL,
  form_code text,
  tax_regime text,
  entity_kind text,
  requires_employees boolean,
  vat_mode text,
  cadence text NOT NULL
    CHECK(cadence IN (
      'MONTHLY','QUARTERLY','ANNUAL','SEMI_MONTHLY','ON_DEMAND'
    )),
  due_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_url text,
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE','RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(code,version)
);

CREATE TABLE accounting_compliance_obligation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  tax_profile_id uuid NOT NULL
    REFERENCES accounting_tax_profile(id) ON DELETE RESTRICT,
  rule_id uuid
    REFERENCES accounting_regulatory_rule(id) ON DELETE RESTRICT,
  authority text NOT NULL CHECK(authority IN ('FNS','SFR','ROSSTAT','OTHER')),
  obligation_type text NOT NULL
    CHECK(obligation_type IN ('FILE','PAY','NOTIFY','RECONCILE')),
  code text NOT NULL,
  title text NOT NULL,
  period_key text NOT NULL,
  due_at timestamptz NOT NULL,
  amount_minor bigint CHECK(amount_minor IS NULL OR amount_minor>=0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  calculation_status text NOT NULL DEFAULT 'NOT_CALCULATED'
    CHECK(calculation_status IN (
      'NOT_CALCULATED','CALCULATED','REVIEW_REQUIRED','CONFIRMED'
    )),
  workflow_status text NOT NULL DEFAULT 'PLANNED'
    CHECK(workflow_status IN (
      'PLANNED','READY','APPROVED','SUBMITTED','ACCEPTED',
      'REJECTED','PAID','CANCELLED'
    )),
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  approved_at timestamptz,
  completed_at timestamptz,
  external_provider text,
  external_reference text,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,legal_entity_id,code,period_key)
);

CREATE INDEX accounting_compliance_due_idx
  ON accounting_compliance_obligation(
    tenant_id,legal_entity_id,due_at,workflow_status
  );

CREATE TABLE accounting_compliance_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL
    REFERENCES accounting_compliance_obligation(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  previous_status text,
  new_status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX accounting_compliance_event_idx
  ON accounting_compliance_event(tenant_id,obligation_id,created_at,id);

CREATE TABLE accounting_reporting_connector (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'DISCONNECTED'
    CHECK(status IN (
      'DISCONNECTED','CONFIGURED','VERIFIED','DEGRADED','DISABLED'
    )),
  supports_filing boolean NOT NULL DEFAULT false,
  supports_receipts boolean NOT NULL DEFAULT false,
  certificate_fingerprint text,
  certificate_valid_to timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,legal_entity_id,provider)
);

CREATE OR REPLACE FUNCTION corebiz_accounting_tax_profile_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM legal_entity l
    WHERE l.tenant_id=NEW.tenant_id
      AND l.id=NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_TAX_PROFILE_LEGAL_ENTITY_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.status='ACTIVE' AND EXISTS(
    SELECT 1
    FROM accounting_tax_profile p
    WHERE p.tenant_id=NEW.tenant_id
      AND p.legal_entity_id=NEW.legal_entity_id
      AND p.status='ACTIVE'
      AND p.id<>NEW.id
      AND daterange(
        p.effective_from,
        coalesce(p.effective_to,'infinity'::date),
        '[]'
      ) && daterange(
        NEW.effective_from,
        coalesce(NEW.effective_to,'infinity'::date),
        '[]'
      )
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_TAX_PROFILE_OVERLAP'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_tax_profile_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_tax_profile
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_tax_profile_guard();

CREATE OR REPLACE FUNCTION corebiz_accounting_compliance_guard()
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
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_PROFILE_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.workflow_status IN ('APPROVED','SUBMITTED','ACCEPTED','PAID')
     AND (
       NEW.approved_by_membership_id IS NULL
       OR NEW.approved_at IS NULL
     ) THEN
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_APPROVAL_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  IF NEW.workflow_status='SUBMITTED'
     AND (
       NEW.external_provider IS NULL
       OR NEW.external_reference IS NULL
     ) THEN
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_SUBMISSION_REFERENCE_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_compliance_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_compliance_obligation
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_compliance_guard();

ALTER TABLE accounting_tax_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_compliance_obligation ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_compliance_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_reporting_connector ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_tax_profile_isolation
  ON accounting_tax_profile
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE POLICY accounting_compliance_obligation_isolation
  ON accounting_compliance_obligation
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE POLICY accounting_compliance_event_isolation
  ON accounting_compliance_event
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE POLICY accounting_reporting_connector_isolation
  ON accounting_reporting_connector
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
  'USN_ANNUAL_DECLARATION_ORG',1,'FNS','FILE',
  'Декларация по УСН организации','USN_DECLARATION',
  'USN','ORGANIZATION',NULL,NULL,'ANNUAL',
  '{"month":3,"day":25,"period":"previous_year"}'::jsonb,
  'https://www.nalog.gov.ru/rn77/ip/ip_pay_taxes/usn/',
  '2026-01-01'
),
(
  'USN_ANNUAL_PAYMENT_ORG',1,'FNS','PAY',
  'Налог по УСН организации за год',NULL,
  'USN','ORGANIZATION',NULL,NULL,'ANNUAL',
  '{"month":3,"day":28,"period":"previous_year"}'::jsonb,
  'https://www.nalog.gov.ru/rn77/ip/ip_pay_taxes/usn/',
  '2026-01-01'
),
(
  'USN_ANNUAL_DECLARATION_IP',1,'FNS','FILE',
  'Декларация по УСН ИП','USN_DECLARATION',
  'USN','IP',NULL,NULL,'ANNUAL',
  '{"month":4,"day":25,"period":"previous_year"}'::jsonb,
  'https://www.nalog.gov.ru/rn77/ip/ip_pay_taxes/usn/',
  '2026-01-01'
),
(
  'USN_ANNUAL_PAYMENT_IP',1,'FNS','PAY',
  'Налог по УСН ИП за год',NULL,
  'USN','IP',NULL,NULL,'ANNUAL',
  '{"month":4,"day":28,"period":"previous_year"}'::jsonb,
  'https://www.nalog.gov.ru/rn77/ip/ip_pay_taxes/usn/',
  '2026-01-01'
),
(
  'VAT_DECLARATION',1,'FNS','FILE',
  'Декларация по НДС','VAT_DECLARATION',
  NULL,NULL,NULL,'VAT_REQUIRED','QUARTERLY',
  '{"day":25,"month_offset":1,"period":"previous_quarter","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/',
  '2026-01-01'
),
(
  'ENS_NOTIFICATION',1,'FNS','NOTIFY',
  'Уведомление об исчисленных суммах налогов и взносов','ENS_NOTIFICATION',
  NULL,NULL,NULL,NULL,'MONTHLY',
  '{"day":25,"period":"current_month","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/',
  '2026-01-01'
);

COMMIT;
