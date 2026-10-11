BEGIN;
ALTER TABLE work_project_client_approval
  ADD COLUMN IF NOT EXISTS recorded_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_reference text;
ALTER TABLE work_project_client_approval
  DROP CONSTRAINT IF EXISTS work_project_approval_evidence_ck;
ALTER TABLE work_project_client_approval
  ADD CONSTRAINT work_project_approval_evidence_ck
  CHECK (evidence_reference IS NULL OR length(evidence_reference)<=500);
CREATE INDEX IF NOT EXISTS project_approval_response_idx
  ON work_project_client_approval(tenant_id,project_id,status,responded_at DESC);
COMMIT;