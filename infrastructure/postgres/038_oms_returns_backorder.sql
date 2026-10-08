BEGIN;

ALTER TABLE oms_order
  DROP CONSTRAINT IF EXISTS oms_order_state_check;

ALTER TABLE oms_order
  ADD CONSTRAINT oms_order_state_check
  CHECK (state IN (
    'READY_FOR_ALLOCATION','ALLOCATING','PARTIALLY_ALLOCATED','ALLOCATED',
    'BACKORDER','ALLOCATION_FAILED','FULFILLMENT','SHIPPED','CANCELLED'
  ));

CREATE TABLE oms_backorder_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  oms_order_id uuid NOT NULL REFERENCES oms_order(id) ON DELETE CASCADE,
  sales_order_line_id uuid NOT NULL REFERENCES sales_order_line(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','PARTIALLY_ALLOCATED','ALLOCATED','CANCELLED')),
  expected_at timestamptz,
  reason text NOT NULL DEFAULT 'INSUFFICIENT_ATP',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, oms_order_id, sales_order_line_id)
);

CREATE INDEX oms_backorder_open_idx
  ON oms_backorder_line(tenant_id,status,created_at)
  WHERE status IN ('OPEN','PARTIALLY_ALLOCATED');

CREATE TABLE return_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN (
      'REQUESTED','AUTHORIZED','IN_TRANSIT','RECEIVED',
      'INSPECTED','COMPLETED','REJECTED','CANCELLED'
    )),
  reason text,
  notes text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  authorized_at timestamptz,
  received_at timestamptz,
  completed_at timestamptz,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  authorized_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,business_number)
);

CREATE TABLE return_request_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  return_request_id uuid NOT NULL REFERENCES return_request(id) ON DELETE CASCADE,
  sales_order_line_id uuid NOT NULL REFERENCES sales_order_line(id) ON DELETE RESTRICT,
  sku_id uuid REFERENCES sku(id) ON DELETE SET NULL,
  requested_quantity_milli bigint NOT NULL CHECK (requested_quantity_milli > 0),
  authorized_quantity_milli bigint NOT NULL DEFAULT 0 CHECK (authorized_quantity_milli >= 0),
  received_quantity_milli bigint NOT NULL DEFAULT 0 CHECK (received_quantity_milli >= 0),
  disposition text
    CHECK (disposition IS NULL OR disposition IN (
      'RESTOCK','QUARANTINE','DAMAGED','RETURN_TO_SUPPLIER','SCRAP','REJECT'
    )),
  warehouse_id uuid REFERENCES warehouse(id) ON DELETE SET NULL,
  inspection_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (authorized_quantity_milli <= requested_quantity_milli),
  CHECK (received_quantity_milli <= authorized_quantity_milli),
  UNIQUE (return_request_id,sales_order_line_id)
);

CREATE INDEX return_request_status_idx
  ON return_request(tenant_id,status,requested_at DESC);

ALTER TABLE oms_backorder_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_request_line ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'oms_backorder_line','return_request','return_request_line'
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

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'returns.read','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','WAREHOUSE','FINANCE','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'returns.manage','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','WAREHOUSE')
ON CONFLICT DO NOTHING;

COMMIT;
