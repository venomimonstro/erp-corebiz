BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS release_candidate_one_approved_idx
  ON release_candidate(tenant_id)
  WHERE status='APPROVED';

COMMIT;
