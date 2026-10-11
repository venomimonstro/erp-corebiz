BEGIN;

CREATE TABLE accounting_compliance_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL
    REFERENCES accounting_compliance_obligation(id) ON DELETE CASCADE,
  line_number integer NOT NULL DEFAULT 1
    CHECK(line_number BETWEEN 1 AND 999),
  kpp text,
  oktmo text,
  kbk text,
  tax_period_code text,
  reporting_year integer
    CHECK(reporting_year IS NULL OR reporting_year BETWEEN 2000 AND 2100),
  amount_minor bigint CHECK(amount_minor IS NULL OR amount_minor>=0),
  source text NOT NULL DEFAULT 'MANUAL'
    CHECK(source IN ('MANUAL','CALCULATION','IMPORT','RULE')),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','CONFIRMED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,obligation_id,line_number),
  CHECK(
    status<>'CONFIRMED'
    OR (
      confirmed_by_membership_id IS NOT NULL
      AND confirmed_at IS NOT NULL
    )
  )
);

CREATE INDEX accounting_compliance_line_obligation_idx
  ON accounting_compliance_line(
    tenant_id,obligation_id,line_number,status
  );

ALTER TABLE accounting_compliance_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounting_compliance_line_isolation
  ON accounting_compliance_line
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE TRIGGER accounting_compliance_line_tenant_refs_v1
BEFORE INSERT OR UPDATE ON accounting_compliance_line
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'obligation_id','accounting_compliance_obligation',
  'confirmed_by_membership_id','tenant_membership'
);

CREATE OR REPLACE FUNCTION corebiz_accounting_compliance_line_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_form_code text;
  v_workflow text;
BEGIN
  SELECT form_code,workflow_status
  INTO v_form_code,v_workflow
  FROM accounting_compliance_obligation
  WHERE tenant_id=NEW.tenant_id AND id=NEW.obligation_id
  FOR UPDATE;

  IF v_workflow IN ('APPROVED','SUBMITTED','ACCEPTED','PAID','CANCELLED') THEN
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_LINE_LOCKED'
      USING ERRCODE='23514';
  END IF;

  IF v_form_code='KND_1110355' AND NEW.status='CONFIRMED' THEN
    IF coalesce(trim(NEW.oktmo),'')=''
       OR coalesce(trim(NEW.kbk),'')=''
       OR coalesce(trim(NEW.tax_period_code),'')=''
       OR NEW.reporting_year IS NULL
       OR NEW.amount_minor IS NULL THEN
      RAISE EXCEPTION 'ACCOUNTING_KND1110355_LINE_INCOMPLETE'
        USING ERRCODE='23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_compliance_line_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_compliance_line
FOR EACH ROW
EXECUTE FUNCTION corebiz_accounting_compliance_line_guard();

COMMIT;
