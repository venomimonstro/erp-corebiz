BEGIN;

CREATE TABLE IF NOT EXISTS party_create_idempotency (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,idempotency_key)
);

ALTER TABLE party_create_idempotency ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS party_create_idempotency_isolation
  ON party_create_idempotency;

CREATE POLICY party_create_idempotency_isolation
  ON party_create_idempotency
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE INDEX IF NOT EXISTS party_create_idempotency_party_idx
  ON party_create_idempotency(tenant_id,party_id);

COMMIT;
