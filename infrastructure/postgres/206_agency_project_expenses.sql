BEGIN;
ALTER TABLE work_project ADD CONSTRAINT work_project_expense_scope_key UNIQUE (tenant_id,id);
CREATE TABLE IF NOT EXISTS work_project_expense (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES work_project(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('CONTRACTOR','SOFTWARE','TRAVEL','OTHER')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 240),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  expense_on date NOT NULL DEFAULT CURRENT_DATE,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_project_expense_tenant_project_fk
    FOREIGN KEY (tenant_id,project_id) REFERENCES work_project(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS work_project_expense_project_date_idx
  ON work_project_expense(tenant_id,project_id,expense_on DESC);
ALTER TABLE work_project_expense ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_project_expense_tenant_isolation ON work_project_expense;
CREATE POLICY work_project_expense_tenant_isolation ON work_project_expense
USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;
