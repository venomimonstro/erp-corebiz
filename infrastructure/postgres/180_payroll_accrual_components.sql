BEGIN;

CREATE TABLE payroll_accrual_component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  employee_ref text NOT NULL,
  source_type text NOT NULL,
  source_key text NOT NULL,
  gross_minor bigint NOT NULL DEFAULT 0 CHECK (gross_minor >= 0),
  deduction_minor bigint NOT NULL DEFAULT 0 CHECK (deduction_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deduction_minor <= gross_minor),
  FOREIGN KEY (tenant_id,batch_id)
    REFERENCES payroll_accrual_batch(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,batch_id,employee_ref,source_type,source_key)
);

CREATE INDEX payroll_accrual_component_employee_idx
  ON payroll_accrual_component(
    tenant_id,batch_id,employee_ref,source_type
  );

INSERT INTO payroll_accrual_component(
  tenant_id,batch_id,employee_ref,source_type,source_key,
  gross_minor,deduction_minor,metadata
)
SELECT
  tenant_id,batch_id,employee_ref,
  'LEGACY_LINE','legacy:'||id::text,
  gross_minor,deduction_minor,
  jsonb_build_object('migratedFromLineId',id)
FROM payroll_accrual_line
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION corebiz_refresh_payroll_line(
  p_tenant_id uuid,
  p_batch_id uuid,
  p_employee_ref text
)
RETURNS void
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_gross bigint;
  v_deduction bigint;
BEGIN
  SELECT
    coalesce(sum(gross_minor),0),
    coalesce(sum(deduction_minor),0)
  INTO v_gross,v_deduction
  FROM payroll_accrual_component
  WHERE tenant_id=p_tenant_id
    AND batch_id=p_batch_id
    AND employee_ref=p_employee_ref;

  INSERT INTO payroll_accrual_line(
    tenant_id,batch_id,employee_ref,gross_minor,deduction_minor
  ) VALUES(
    p_tenant_id,p_batch_id,p_employee_ref,v_gross,v_deduction
  )
  ON CONFLICT(tenant_id,batch_id,employee_ref)
  DO UPDATE SET
    gross_minor=EXCLUDED.gross_minor,
    deduction_minor=EXCLUDED.deduction_minor;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_payroll_component_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_batch uuid;
  v_employee text;
BEGIN
  IF TG_OP='DELETE' THEN
    v_tenant:=OLD.tenant_id;
    v_batch:=OLD.batch_id;
    v_employee:=OLD.employee_ref;
  ELSE
    v_tenant:=NEW.tenant_id;
    v_batch:=NEW.batch_id;
    v_employee:=NEW.employee_ref;
  END IF;

  IF NOT EXISTS(
    SELECT 1
    FROM payroll_accrual_batch b
    WHERE b.tenant_id=v_tenant
      AND b.id=v_batch
      AND b.status='DRAFT'
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'Payroll component modifications require draft batch';
  END IF;

  RETURN coalesce(NEW,OLD);
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_payroll_component_refresh()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
    OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.batch_id IS DISTINCT FROM NEW.batch_id
    OR OLD.employee_ref IS DISTINCT FROM NEW.employee_ref
  ) THEN
    PERFORM corebiz_refresh_payroll_line(
      OLD.tenant_id,OLD.batch_id,OLD.employee_ref
    );
  END IF;

  IF TG_OP='DELETE' THEN
    PERFORM corebiz_refresh_payroll_line(
      OLD.tenant_id,OLD.batch_id,OLD.employee_ref
    );
    RETURN OLD;
  END IF;

  PERFORM corebiz_refresh_payroll_line(
    NEW.tenant_id,NEW.batch_id,NEW.employee_ref
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER payroll_accrual_component_guard_v1
BEFORE INSERT OR UPDATE OR DELETE
ON payroll_accrual_component
FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_component_guard();

CREATE TRIGGER payroll_accrual_component_refresh_v1
AFTER INSERT OR UPDATE OR DELETE
ON payroll_accrual_component
FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_component_refresh();

ALTER TABLE payroll_accrual_component ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_accrual_component_isolation
  ON payroll_accrual_component
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

COMMIT;
