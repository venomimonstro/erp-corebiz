BEGIN;

CREATE TABLE release_candidate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  target_version text NOT NULL CHECK (length(target_version) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','BLOCKED','READY_FOR_APPROVAL','APPROVED','REJECTED','SUPERSEDED')),
  verdict_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  reviewed_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  review_reason text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX release_candidate_one_active_target_idx
  ON release_candidate(tenant_id,target_version)
  WHERE status IN ('DRAFT','BLOCKED','READY_FOR_APPROVAL','APPROVED');

CREATE INDEX release_candidate_tenant_idx
  ON release_candidate(tenant_id,created_at DESC);

ALTER TABLE release_candidate ENABLE ROW LEVEL SECURITY;

CREATE POLICY release_candidate_isolation
  ON release_candidate
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'release.approve','all'
FROM tenant_role r
WHERE r.code='OWNER'
ON CONFLICT DO NOTHING;

COMMIT;
