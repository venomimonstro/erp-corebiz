BEGIN;

CREATE TABLE tenant_pilot_exit_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  pilot_enrollment_id uuid NOT NULL REFERENCES tenant_pilot_enrollment(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK(decision IN ('PASS','BLOCKED')),
  verdict jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  reviewed_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_pilot_exit_review_history_idx
  ON tenant_pilot_exit_review(
    tenant_id,pilot_enrollment_id,reviewed_at DESC
  );

ALTER TABLE tenant_pilot_exit_review ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_pilot_exit_review_isolation
  ON tenant_pilot_exit_review
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

COMMIT;
