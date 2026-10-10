BEGIN;

CREATE TABLE tenant_pilot_enrollment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cohort_code text NOT NULL CHECK(length(cohort_code) BETWEEN 2 AND 80),
  status text NOT NULL DEFAULT 'PLANNED'
    CHECK(status IN (
      'PLANNED','READY','RUNNING','PAUSED','COMPLETED','STOPPED'
    )),
  profile_snapshot text NOT NULL,
  release_candidate_id uuid REFERENCES release_candidate(id) ON DELETE RESTRICT,
  pilot_owner_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  planned_start_at timestamptz,
  target_end_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  paused_at timestamptz,
  stopped_at timestamptz,
  stop_reason text,
  success_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

CREATE INDEX tenant_pilot_enrollment_status_idx
  ON tenant_pilot_enrollment(status,updated_at DESC);

CREATE TABLE tenant_pilot_status_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  pilot_enrollment_id uuid NOT NULL REFERENCES tenant_pilot_enrollment(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  reason text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_pilot_status_event_history_idx
  ON tenant_pilot_status_event(tenant_id,pilot_enrollment_id,created_at DESC);

ALTER TABLE tenant_hypercare_snapshot
  ADD COLUMN pilot_enrollment_id uuid
  REFERENCES tenant_pilot_enrollment(id) ON DELETE SET NULL;

CREATE INDEX tenant_hypercare_snapshot_pilot_idx
  ON tenant_hypercare_snapshot(tenant_id,pilot_enrollment_id,captured_at DESC)
  WHERE pilot_enrollment_id IS NOT NULL;

ALTER TABLE tenant_pilot_enrollment ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pilot_status_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_pilot_enrollment_isolation
  ON tenant_pilot_enrollment
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE POLICY tenant_pilot_status_event_isolation
  ON tenant_pilot_status_event
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'pilot.read','all'
FROM tenant_role r
WHERE r.code IN ('OWNER','ADMIN','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'pilot.manage','all'
FROM tenant_role r
WHERE r.code IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

COMMIT;
