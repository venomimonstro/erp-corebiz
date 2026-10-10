BEGIN;

CREATE INDEX IF NOT EXISTS audit_event_action_idx
  ON audit_event(tenant_id,action,created_at DESC);

CREATE INDEX IF NOT EXISTS audit_event_resource_idx
  ON audit_event(tenant_id,resource_type,resource_id,created_at DESC);

CREATE INDEX IF NOT EXISTS user_session_user_active_idx
  ON user_session(user_id,revoked_at,expires_at,last_seen_at DESC);

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'audit.read','all'
FROM tenant_role r
WHERE r.code IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

COMMIT;
