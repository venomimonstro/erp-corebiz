BEGIN;

CREATE TABLE wms_scan_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES warehouse_task(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  scan_type text NOT NULL
    CHECK (scan_type IN ('FROM_LOCATION','TO_LOCATION','SKU','ORDER')),
  scanned_value text NOT NULL,
  matched_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id,membership_id,scan_type)
);

CREATE INDEX wms_scan_event_task_idx
  ON wms_scan_event(tenant_id,warehouse_id,task_id,created_at);

ALTER TABLE wms_scan_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_scan_event_isolation
  ON wms_scan_event
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
