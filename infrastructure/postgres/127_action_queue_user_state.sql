BEGIN;

CREATE TABLE action_queue_user_state (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  state text NOT NULL DEFAULT 'UNREAD'
    CHECK(state IN ('UNREAD','READ','SNOOZED')),
  snoozed_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,membership_id,source_key),
  CHECK(
    state <> 'SNOOZED'
    OR snoozed_until IS NOT NULL
  )
);

CREATE INDEX action_queue_user_state_snooze_idx
  ON action_queue_user_state(
    tenant_id,membership_id,state,snoozed_until
  );

ALTER TABLE action_queue_user_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY action_queue_user_state_isolation
  ON action_queue_user_state
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

COMMIT;
