BEGIN;

CREATE TABLE tenant_pilot_incident (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  pilot_enrollment_id uuid NOT NULL REFERENCES tenant_pilot_enrollment(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK(severity IN ('P0','P1','P2','P3')),
  code text NOT NULL CHECK(length(code) BETWEEN 2 AND 100),
  summary text NOT NULL CHECK(length(summary) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK(status IN ('OPEN','MITIGATED','RESOLVED')),
  opened_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  resolved_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  resolution_note text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_pilot_incident_open_idx
  ON tenant_pilot_incident(tenant_id,pilot_enrollment_id,severity,opened_at DESC)
  WHERE status <> 'RESOLVED';

ALTER TABLE tenant_pilot_incident ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_pilot_incident_isolation
  ON tenant_pilot_incident
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

COMMIT;
