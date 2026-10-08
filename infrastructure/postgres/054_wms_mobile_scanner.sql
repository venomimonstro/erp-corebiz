BEGIN;

ALTER TABLE warehouse_task
  DROP CONSTRAINT IF EXISTS warehouse_task_status_check;

ALTER TABLE warehouse_task
  ADD CONSTRAINT warehouse_task_status_check
  CHECK (status IN (
    'OPEN','CLAIMED','BLOCKED','COMPLETED','CANCELLED','FAILED'
  ));

CREATE TABLE wms_task_scan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES warehouse_task(id) ON DELETE CASCADE,
  scan_kind text NOT NULL
    CHECK (scan_kind IN ('FROM_LOCATION','SKU','TO_LOCATION')),
  scanned_value text NOT NULL,
  verified boolean NOT NULL DEFAULT true,
  idempotency_key text NOT NULL,
  actor_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key)
);

CREATE INDEX wms_task_scan_task_idx
  ON wms_task_scan(tenant_id,task_id,scanned_at);

CREATE TABLE wms_task_exception (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES warehouse_task(id) ON DELETE CASCADE,
  exception_type text NOT NULL
    CHECK (exception_type IN (
      'STOCK_MISMATCH','LOCATION_BLOCKED','BARCODE_MISMATCH',
      'DAMAGE','EQUIPMENT','OTHER'
    )),
  message text,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','RESOLVED','CANCELLED')),
  reported_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  reported_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL
);

CREATE INDEX wms_task_exception_open_idx
  ON wms_task_exception(tenant_id,task_id,status,reported_at DESC)
  WHERE status='OPEN';

ALTER TABLE wms_task_scan ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_task_exception ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_task_scan_isolation
  ON wms_task_scan
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY wms_task_exception_isolation
  ON wms_task_exception
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
