BEGIN;

CREATE TABLE tenant_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  invited_by_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_invitation_tenant_idx
  ON tenant_invitation(tenant_id, status);

CREATE INDEX tenant_invitation_email_idx
  ON tenant_invitation(lower(email), status);

ALTER TABLE tenant_invitation ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_invitation_isolation
  ON tenant_invitation
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
