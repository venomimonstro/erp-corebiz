BEGIN;

CREATE TABLE wms_3pl_client_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE CASCADE,
  warehouse_id uuid REFERENCES warehouse(id) ON DELETE SET NULL,
  request_number text NOT NULL,
  request_type text NOT NULL
    CHECK (request_type IN (
      'DAMAGE','SHORTAGE','DELAY','DOCUMENT','GENERAL'
    )),
  priority text NOT NULL DEFAULT 'P3'
    CHECK (priority IN ('P1','P2','P3','P4')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN (
      'OPEN','IN_PROGRESS','WAITING_CLIENT','RESOLVED','CLOSED'
    )),
  subject text NOT NULL,
  sla_due_at timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at timestamptz,
  created_by_access_id uuid REFERENCES wms_3pl_portal_access(id) ON DELETE SET NULL,
  assigned_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,request_number)
);

CREATE INDEX wms_3pl_client_request_queue_idx
  ON wms_3pl_client_request(
    tenant_id,status,priority,sla_due_at,created_at
  );

CREATE INDEX wms_3pl_client_request_owner_idx
  ON wms_3pl_client_request(
    tenant_id,owner_id,created_at DESC
  );

CREATE TABLE wms_3pl_client_request_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES wms_3pl_client_request(id) ON DELETE CASCADE,
  author_type text NOT NULL
    CHECK (author_type IN ('CLIENT','OPERATOR','SYSTEM')),
  author_access_id uuid REFERENCES wms_3pl_portal_access(id) ON DELETE SET NULL,
  author_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (author_type='CLIENT' AND author_access_id IS NOT NULL AND author_membership_id IS NULL)
    OR
    (author_type='OPERATOR' AND author_membership_id IS NOT NULL AND author_access_id IS NULL)
    OR
    (author_type='SYSTEM' AND author_access_id IS NULL AND author_membership_id IS NULL)
  )
);

CREATE INDEX wms_3pl_client_request_message_idx
  ON wms_3pl_client_request_message(
    tenant_id,request_id,created_at,id
  );

ALTER TABLE wms_3pl_client_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_3pl_client_request_message ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_3pl_client_request_isolation
  ON wms_3pl_client_request
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY wms_3pl_client_request_message_isolation
  ON wms_3pl_client_request_message
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION corebiz_3pl_request_message_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '3PL request messages are immutable'
    USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER wms_3pl_request_message_immutable_v1
BEFORE UPDATE OR DELETE ON wms_3pl_client_request_message
FOR EACH ROW EXECUTE FUNCTION corebiz_3pl_request_message_immutable();

COMMIT;
