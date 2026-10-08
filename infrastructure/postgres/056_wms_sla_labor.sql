BEGIN;

CREATE TABLE wms_task_sla_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  task_type text NOT NULL
    CHECK (task_type IN (
      'PUTAWAY','PICK','PACK','SHIP','COUNT','REPLENISH'
    )),
  warning_minutes integer NOT NULL DEFAULT 15
    CHECK (warning_minutes BETWEEN 1 AND 1440),
  critical_minutes integer NOT NULL DEFAULT 30
    CHECK (critical_minutes BETWEEN 1 AND 2880),
  enabled boolean NOT NULL DEFAULT true,
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,warehouse_id,task_type),
  CHECK (critical_minutes >= warning_minutes)
);

ALTER TABLE wms_task_sla_policy ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_task_sla_policy_isolation
  ON wms_task_sla_policy
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

ALTER TABLE wms_task_exception
  ADD COLUMN IF NOT EXISTS resolution_action text,
  ADD COLUMN IF NOT EXISTS resolution_note text;

ALTER TABLE wms_task_exception
  DROP CONSTRAINT IF EXISTS wms_task_exception_resolution_action_check;

ALTER TABLE wms_task_exception
  ADD CONSTRAINT wms_task_exception_resolution_action_check
  CHECK (
    resolution_action IS NULL OR
    resolution_action IN ('RESUME','RETRY','CANCEL')
  );

CREATE INDEX IF NOT EXISTS warehouse_task_sla_scan_idx
  ON warehouse_task(
    tenant_id,warehouse_id,task_type,status,claimed_at,created_at
  )
  WHERE status IN ('OPEN','CLAIMED','BLOCKED','FAILED');

CREATE INDEX IF NOT EXISTS warehouse_task_worker_perf_idx
  ON warehouse_task(
    tenant_id,warehouse_id,claimed_by_membership_id,completed_at
  )
  WHERE claimed_by_membership_id IS NOT NULL;

COMMIT;
