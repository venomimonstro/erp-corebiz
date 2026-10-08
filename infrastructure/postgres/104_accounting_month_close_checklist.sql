BEGIN;
CREATE TABLE accounting_month_close_check (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 period_id uuid NOT NULL,
 code text NOT NULL CHECK (code IN ('JOURNAL','BANK','RECEIVABLES','PAYABLES','INVENTORY','VAT','PAYROLL')),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','BLOCKED')),
 note text,
 checked_by_membership_id uuid REFERENCES tenant_membership(id),
 checked_at timestamptz,
 UNIQUE(tenant_id,period_id,code),
 FOREIGN KEY(tenant_id,period_id) REFERENCES accounting_period(tenant_id,id)
);
ALTER TABLE accounting_month_close_check ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounting_month_close_check_isolation ON accounting_month_close_check
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;