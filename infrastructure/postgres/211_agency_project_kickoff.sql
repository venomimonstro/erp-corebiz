BEGIN;
CREATE TABLE work_project_template_application(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  template_code text NOT NULL CHECK(length(template_code) BETWEEN 2 AND 40),
  applied_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,project_id,template_code),
  FOREIGN KEY(tenant_id,project_id) REFERENCES work_project(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE work_project_template_application ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_project_template_application_isolation ON work_project_template_application
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;