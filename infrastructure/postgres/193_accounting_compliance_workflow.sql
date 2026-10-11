BEGIN;

-- Sprint 51b — owner-first Russian tax compliance workflow.
-- Regulatory dates are versioned evidence, never silently hard-coded as eternal truth.

ALTER TABLE accounting_tax_profile
  ADD COLUMN IF NOT EXISTS okved_primary text,
  ADD COLUMN IF NOT EXISTS kpp text,
  ADD COLUMN IF NOT EXISTS oktmo text,
  ADD COLUMN IF NOT EXISTS reporting_mode text NOT NULL DEFAULT 'ASSISTED',
  ADD COLUMN IF NOT EXISTS risk_tolerance text NOT NULL DEFAULT 'CONSERVATIVE';

ALTER TABLE accounting_tax_profile
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_reporting_mode_ck,
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_risk_tolerance_ck;

ALTER TABLE accounting_tax_profile
  ADD CONSTRAINT accounting_tax_profile_reporting_mode_ck
    CHECK(reporting_mode IN ('ASSISTED','SEMI_AUTOMATIC','EXTERNAL_ACCOUNTANT')),
  ADD CONSTRAINT accounting_tax_profile_risk_tolerance_ck
    CHECK(risk_tolerance IN ('CONSERVATIVE','STANDARD'));

ALTER TABLE accounting_compliance_obligation
  ADD COLUMN IF NOT EXISTS form_code text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_effective_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_obligation_id uuid
    REFERENCES financial_obligation(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS packet_id uuid,
  ADD COLUMN IF NOT EXISTS review_note text;

CREATE TABLE accounting_compliance_packet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL
    REFERENCES accounting_compliance_obligation(id) ON DELETE CASCADE,
  packet_kind text NOT NULL
    CHECK(packet_kind IN (
      'FNS_NOTIFICATION','FNS_DECLARATION','SFR_REPORT',
      'PAYMENT_INSTRUCTION','RECONCILIATION','OTHER'
    )),
  format text NOT NULL DEFAULT 'JSON'
    CHECK(format IN ('JSON','XML','PDF','TXT')),
  form_code text,
  schema_version text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum_sha256 text,
  validation_status text NOT NULL DEFAULT 'DRAFT'
    CHECK(validation_status IN (
      'DRAFT','VALID','REVIEW_REQUIRED','INVALID'
    )),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  signature_status text NOT NULL DEFAULT 'UNSIGNED'
    CHECK(signature_status IN (
      'UNSIGNED','SIGNATURE_REQUIRED','SIGNED','SIGNATURE_INVALID'
    )),
  signed_at timestamptz,
  signed_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,obligation_id,packet_kind)
);

ALTER TABLE accounting_compliance_packet
  ADD CONSTRAINT accounting_compliance_packet_tenant_id_uq
  UNIQUE(tenant_id,id);

ALTER TABLE accounting_compliance_obligation
  ADD CONSTRAINT accounting_compliance_obligation_packet_fk
  FOREIGN KEY(tenant_id,packet_id)
  REFERENCES accounting_compliance_packet(tenant_id,id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE accounting_compliance_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL
    REFERENCES accounting_compliance_obligation(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_reference text NOT NULL,
  receipt_type text NOT NULL
    CHECK(receipt_type IN (
      'SENT','DELIVERED','ACCEPTED','REJECTED','CLARIFICATION','PAYMENT'
    )),
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,provider,external_reference,receipt_type)
);

CREATE INDEX accounting_compliance_packet_obligation_idx
  ON accounting_compliance_packet(tenant_id,obligation_id,validation_status);

CREATE INDEX accounting_compliance_receipt_obligation_idx
  ON accounting_compliance_receipt(tenant_id,obligation_id,received_at DESC);

ALTER TABLE accounting_compliance_packet ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_compliance_receipt ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_compliance_packet_isolation
  ON accounting_compliance_packet
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE POLICY accounting_compliance_receipt_isolation
  ON accounting_compliance_receipt
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE OR REPLACE FUNCTION corebiz_accounting_compliance_packet_guard()
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
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_PACKET_OBLIGATION_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.signature_status='SIGNED'
     AND (
       NEW.signed_at IS NULL
       OR NEW.signed_by_membership_id IS NULL
     ) THEN
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_PACKET_SIGNATURE_AUDIT_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_compliance_packet_guard_v1
  ON accounting_compliance_packet;
CREATE TRIGGER accounting_compliance_packet_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_compliance_packet
FOR EACH ROW
EXECUTE FUNCTION corebiz_accounting_compliance_packet_guard();

CREATE OR REPLACE FUNCTION corebiz_accounting_compliance_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.workflow_status IS DISTINCT FROM OLD.workflow_status THEN
    IF NOT (
      (OLD.workflow_status='PLANNED' AND NEW.workflow_status IN ('READY','CANCELLED'))
      OR (OLD.workflow_status='READY' AND NEW.workflow_status IN ('APPROVED','CANCELLED'))
      OR (OLD.workflow_status='APPROVED' AND NEW.workflow_status IN ('SUBMITTED','PAID','CANCELLED'))
      OR (OLD.workflow_status='SUBMITTED' AND NEW.workflow_status IN ('ACCEPTED','REJECTED'))
      OR (OLD.workflow_status='REJECTED' AND NEW.workflow_status IN ('READY','CANCELLED'))
      OR (OLD.workflow_status=NEW.workflow_status)
    ) THEN
      RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_INVALID_TRANSITION'
        USING ERRCODE='23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_compliance_transition_guard_v1
  ON accounting_compliance_obligation;
CREATE TRIGGER accounting_compliance_transition_guard_v1
BEFORE UPDATE OF workflow_status
ON accounting_compliance_obligation
FOR EACH ROW
EXECUTE FUNCTION corebiz_accounting_compliance_transition_guard();

-- Complete the rule catalog needed by owner-facing calendar.
INSERT INTO accounting_regulatory_rule(
  code,version,authority,obligation_type,title,form_code,
  tax_regime,entity_kind,requires_employees,vat_mode,
  cadence,due_rule,source_url,effective_from
) VALUES
(
  'USN_ADVANCE_NOTIFICATION',1,'FNS','NOTIFY',
  'Уведомление по авансовому платежу УСН','KND_1110355',
  'USN',NULL,NULL,NULL,'QUARTERLY',
  '{"months":[4,7,10],"day":25,"period":"previous_quarter","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/','2026-01-01'
),
(
  'USN_ADVANCE_PAYMENT',1,'FNS','PAY',
  'Авансовый платеж по УСН',NULL,
  'USN',NULL,NULL,NULL,'QUARTERLY',
  '{"months":[4,7,10],"day":28,"period":"previous_quarter","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/','2026-01-01'
),
(
  'NDFL_1_22_NOTIFICATION',1,'FNS','NOTIFY',
  'Уведомление по НДФЛ за 1–22 число','KND_1110355',
  NULL,NULL,true,NULL,'MONTHLY',
  '{"day":25,"period":"current_month_1_22","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/','2026-01-01'
),
(
  'NDFL_1_22_PAYMENT',1,'FNS','PAY',
  'Уплата НДФЛ за 1–22 число',NULL,
  NULL,NULL,true,NULL,'MONTHLY',
  '{"day":28,"period":"current_month_1_22","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/','2026-01-01'
),
(
  'NDFL_23_EOM_NOTIFICATION',1,'FNS','NOTIFY',
  'Уведомление по НДФЛ за 23–последнее число','KND_1110355',
  NULL,NULL,true,NULL,'MONTHLY',
  '{"next_month_day":3,"period":"current_month_23_eom","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/','2026-01-01'
),
(
  'NDFL_23_EOM_PAYMENT',1,'FNS','PAY',
  'Уплата НДФЛ за 23–последнее число',NULL,
  NULL,NULL,true,NULL,'MONTHLY',
  '{"next_month_day":5,"period":"current_month_23_eom","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/','2026-01-01'
),
(
  'INSURANCE_NOTIFICATION',1,'FNS','NOTIFY',
  'Уведомление по страховым взносам','KND_1110355',
  NULL,NULL,true,NULL,'MONTHLY',
  '{"day":25,"period":"previous_month","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/','2026-01-01'
),
(
  'INSURANCE_PAYMENT',1,'FNS','PAY',
  'Уплата страховых взносов',NULL,
  NULL,NULL,true,NULL,'MONTHLY',
  '{"day":28,"period":"previous_month","business_day_shift":true}'::jsonb,
  'https://www.nalog.gov.ru/rn23/ens/','2026-01-01'
)
ON CONFLICT(code,version) DO NOTHING;

-- Correct broad matching markers introduced in 192.
UPDATE accounting_regulatory_rule
SET source_url='https://www.nalog.gov.ru/rn23/ens/'
WHERE code='ENS_NOTIFICATION' AND version=1;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,p.permission_code,'all'
FROM tenant_role r
CROSS JOIN (VALUES
  ('accounting.compliance.read'),
  ('accounting.compliance.manage'),
  ('accounting.compliance.approve')
) AS p(permission_code)
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
