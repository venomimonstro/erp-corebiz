BEGIN;

CREATE TABLE domain_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  event_name text NOT NULL,
  entity_type text,
  entity_id uuid,
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  depth integer NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 5),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','PROCESSED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX domain_event_outbox_pending_idx
  ON domain_event_outbox(status, next_attempt_at, created_at)
  WHERE status IN ('PENDING','FAILED');

CREATE TABLE workflow_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_event text NOT NULL,
  entity_type text,
  enabled boolean NOT NULL DEFAULT true,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_definition_trigger_idx
  ON workflow_definition(tenant_id, trigger_event, enabled);

CREATE TABLE workflow_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflow_definition(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  published_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE UNIQUE INDEX workflow_one_published_version_uq
  ON workflow_version(workflow_id)
  WHERE status = 'PUBLISHED';

CREATE TABLE workflow_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflow_definition(id) ON DELETE CASCADE,
  workflow_version_id uuid NOT NULL REFERENCES workflow_version(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL REFERENCES domain_event_outbox(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING','SUCCEEDED','SKIPPED','FAILED')),
  depth integer NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 5),
  input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (workflow_version_id, event_id)
);

CREATE INDEX workflow_execution_recent_idx
  ON workflow_execution(tenant_id, started_at DESC);

CREATE TABLE entity_tag (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  tag text NOT NULL,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_type, entity_id, tag)
);

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  recipient_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'WORKFLOW',
  title text NOT NULL,
  body text,
  linked_type text,
  linked_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_recipient_idx
  ON notification(tenant_id, recipient_membership_id, read_at, created_at DESC);

ALTER TABLE workflow_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'workflow_definition','workflow_version','workflow_execution',
    'entity_tag','notification'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'workflow.manage', 'all'
FROM tenant_role r
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

COMMIT;
