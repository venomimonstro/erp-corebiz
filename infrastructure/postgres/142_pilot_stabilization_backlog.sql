BEGIN;

CREATE TABLE tenant_pilot_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  pilot_enrollment_id uuid NOT NULL REFERENCES tenant_pilot_enrollment(id) ON DELETE CASCADE,
  category text NOT NULL
    CHECK(category IN ('BUG','UX','SPEC_GAP','FEATURE')),
  priority text NOT NULL DEFAULT 'P2'
    CHECK(priority IN ('P0','P1','P2','P3','P4')),
  disposition text
    CHECK(disposition IS NULL OR disposition IN (
      'CORE','MODULE','CONFIG','EXTENSION','REJECT'
    )),
  status text NOT NULL DEFAULT 'NEW'
    CHECK(status IN (
      'NEW','TRIAGED','IN_PROGRESS','VERIFY','DONE','REJECTED'
    )),
  release_blocking boolean NOT NULL DEFAULT false,
  title text NOT NULL CHECK(length(title) BETWEEN 3 AND 300),
  description text,
  screen_path text,
  source_incident_id uuid REFERENCES tenant_pilot_incident(id) ON DELETE SET NULL,
  source_ticket_id uuid REFERENCES support_ticket(id) ON DELETE SET NULL,
  root_cause text,
  remediation text,
  fix_version text,
  verification_reference text,
  owner_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  verified_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_pilot_feedback_queue_idx
  ON tenant_pilot_feedback(
    tenant_id,status,release_blocking DESC,priority,created_at
  );

CREATE INDEX tenant_pilot_feedback_blocker_idx
  ON tenant_pilot_feedback(tenant_id,pilot_enrollment_id,priority)
  WHERE release_blocking=true
    AND status NOT IN ('DONE','REJECTED');

ALTER TABLE tenant_pilot_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_pilot_feedback_isolation
  ON tenant_pilot_feedback
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

COMMIT;
