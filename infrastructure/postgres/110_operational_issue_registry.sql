BEGIN;
CREATE TABLE tenant_operational_issue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 issue_code text NOT NULL CHECK(issue_code IN ('BANK_UNMATCHED','VAT_UNREGISTERED','CLOSE_BLOCKED','PAYROLL_DRAFT')),
 reference_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RESOLVED')),
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 UNIQUE(tenant_id,issue_code,reference_id),
 CHECK((state='OPEN' AND resolved_at IS NULL) OR (state='RESOLVED' AND resolved_at IS NOT NULL))
);
ALTER TABLE tenant_operational_issue ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_operational_issue_isolation ON tenant_operational_issue
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;