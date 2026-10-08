BEGIN;

CREATE TABLE wms_cycle_count (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','POSTED','CANCELLED')),
  zone_id uuid REFERENCES warehouse_zone(id) ON DELETE SET NULL,
  location_id uuid REFERENCES warehouse_location(id) ON DELETE SET NULL,
  reason text,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  cancelled_at timestamptz
);

CREATE INDEX wms_cycle_count_queue_idx
  ON wms_cycle_count(tenant_id,warehouse_id,status,created_at DESC);

CREATE TABLE wms_cycle_count_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  count_id uuid NOT NULL REFERENCES wms_cycle_count(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  expected_milli bigint NOT NULL CHECK (expected_milli >= 0),
  counted_milli bigint CHECK (counted_milli IS NULL OR counted_milli >= 0),
  variance_milli bigint,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','POSTED','CANCELLED')),
  task_id uuid REFERENCES warehouse_task(id) ON DELETE SET NULL,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (count_id,location_id,sku_id)
);

CREATE INDEX wms_cycle_count_line_task_idx
  ON wms_cycle_count_line(tenant_id,task_id)
  WHERE task_id IS NOT NULL;

ALTER TABLE wms_cycle_count ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_cycle_count_line ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_cycle_count_isolation
  ON wms_cycle_count
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY wms_cycle_count_line_isolation
  ON wms_cycle_count_line
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
