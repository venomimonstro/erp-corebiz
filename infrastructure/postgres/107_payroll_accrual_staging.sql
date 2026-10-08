BEGIN;
CREATE TABLE payroll_accrual_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 legal_entity_id uuid NOT NULL REFERENCES legal_entity(id),
 period_from date NOT NULL, period_to date NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED')),
 currency char(3) NOT NULL DEFAULT 'RUB',
 approved_by_membership_id uuid REFERENCES tenant_membership(id),
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(period_from<=period_to),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,legal_entity_id,period_from,period_to)
);
CREATE TABLE payroll_accrual_line (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 batch_id uuid NOT NULL,
 employee_ref text NOT NULL,
 gross_minor bigint NOT NULL CHECK(gross_minor>=0),
 deduction_minor bigint NOT NULL DEFAULT 0 CHECK(deduction_minor>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(deduction_minor<=gross_minor),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES payroll_accrual_batch(tenant_id,id),
 UNIQUE(tenant_id,batch_id,employee_ref)
);
CREATE OR REPLACE FUNCTION corebiz_payroll_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legal_entity e WHERE e.id=NEW.legal_entity_id AND e.tenant_id=NEW.tenant_id)
 THEN RAISE EXCEPTION 'Payroll legal entity mismatch'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='APPROVED' THEN RAISE EXCEPTION 'Approved payroll batch immutable'; END IF;
 IF NEW.status='APPROVED' AND (NEW.approved_by_membership_id IS NULL OR NEW.approved_at IS NULL)
 THEN RAISE EXCEPTION 'Payroll batch approval requires actor and timestamp'; END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER payroll_batch_guard_v1 BEFORE INSERT OR UPDATE ON payroll_accrual_batch
 FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_batch_guard();
CREATE OR REPLACE FUNCTION corebiz_payroll_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payroll line deletion blocked'; END IF;
 IF NOT EXISTS(SELECT 1 FROM payroll_accrual_batch b WHERE b.id=NEW.batch_id AND b.tenant_id=NEW.tenant_id AND b.status='DRAFT' FOR UPDATE)
 THEN RAISE EXCEPTION 'Payroll line requires draft batch'; END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER payroll_line_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON payroll_accrual_line
 FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_line_guard();
ALTER TABLE payroll_accrual_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_accrual_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_batch_isolation ON payroll_accrual_batch USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY payroll_line_isolation ON payroll_accrual_line USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;