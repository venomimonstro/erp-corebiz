BEGIN;

ALTER TABLE user_session
  ADD COLUMN active_membership_id uuid
  REFERENCES tenant_membership(id) ON DELETE SET NULL;

CREATE INDEX user_session_active_membership_idx
  ON user_session(active_membership_id);

CREATE TABLE email_verification_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_user_idx
  ON email_verification_token(user_id);

CREATE TABLE password_reset_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_user_idx
  ON password_reset_token(user_id);

COMMIT;
