BEGIN;

CREATE TABLE wms_wave (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  strategy text NOT NULL
    CHECK (strategy IN ('ORDER','BATCH','ZONE','CLUSTER')),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','RELEASED','IN_PROGRESS','COMPLETED','CANCELLED')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  max_tasks integer NOT NULL DEFAULT 50 CHECK (max_tasks BETWEEN 1 AND 500),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  released_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz
);

CREATE INDEX wms_wave_queue_idx
  ON wms_wave(tenant_id,warehouse_id,status,priority,created_at DESC);

ALTER TABLE warehouse_task
  ADD COLUMN IF NOT EXISTS wave_id uuid REFERENCES wms_wave(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cluster_slot text;

CREATE INDEX IF NOT EXISTS warehouse_task_wave_idx
  ON warehouse_task(tenant_id,wave_id,status,priority,created_at)
  WHERE wave_id IS NOT NULL;

ALTER TABLE wms_wave ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_wave_isolation
  ON wms_wave
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
