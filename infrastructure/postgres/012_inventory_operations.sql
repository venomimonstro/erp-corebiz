BEGIN;

CREATE TABLE inventory_transfer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  from_warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  to_warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  idempotency_key text,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  posted_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_number),
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE UNIQUE INDEX inventory_transfer_idempotency_uq
  ON inventory_transfer(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE inventory_transfer_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES inventory_transfer(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, sku_id)
);

CREATE INDEX inventory_transfer_status_idx
  ON inventory_transfer(tenant_id, status, created_at DESC);

ALTER TABLE inventory_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfer_line ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_transfer_isolation
  ON inventory_transfer
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY inventory_transfer_line_isolation
  ON inventory_transfer_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
