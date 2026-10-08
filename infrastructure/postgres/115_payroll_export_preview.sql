BEGIN;
CREATE TABLE payroll_accrual_export (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 batch_id uuid NOT NULL,
 export_kind text NOT NULL CHECK(export_kind IN ('ACCOUNTING_PREVIEW','PAYMENT_PREVIEW')),
 status text NOT NULL DEFAULT 'PREPARED' CHECK(status='PREPARED'),
 prepared_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id),
 prepared_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,batch_id,export_kind),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES payroll_accrual_batch(tenant_id,id)
);
CREATE OR REPLACE FUNCTION corebiz_payroll_export_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM payroll_accrual_batch b
    WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id AND b.status='APPROVED' FOR UPDATE)
  THEN RAISE EXCEPTION 'Payroll export requires approved batch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM tenant_membership m
    WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.prepared_by_membership_id)
  THEN RAISE EXCEPTION 'Payroll export actor tenant mismatch'; END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Payroll export audit is immutable';
END;$$;
CREATE TRIGGER payroll_export_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON payroll_accrual_export
 FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_export_guard();
ALTER TABLE payroll_accrual_export ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_accrual_export_isolation ON payroll_accrual_export
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;