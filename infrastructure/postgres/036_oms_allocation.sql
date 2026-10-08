BEGIN;

CREATE TABLE inventory_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  safety_stock_milli bigint NOT NULL DEFAULT 0 CHECK (safety_stock_milli >= 0),
  sourcing_priority integer NOT NULL DEFAULT 100 CHECK (sourcing_priority BETWEEN 0 AND 10000),
  enabled boolean NOT NULL DEFAULT true,
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, warehouse_id, sku_id)
);

CREATE TABLE oms_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'READY_FOR_ALLOCATION'
    CHECK (state IN (
      'READY_FOR_ALLOCATION','ALLOCATING','ALLOCATED',
      'ALLOCATION_FAILED','FULFILLMENT','SHIPPED','CANCELLED'
    )),
  allocation_version integer NOT NULL DEFAULT 0 CHECK (allocation_version >= 0),
  last_sourcing_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sales_order_id)
);

CREATE INDEX oms_order_state_idx
  ON oms_order(tenant_id, state, updated_at DESC);

CREATE TABLE oms_sourcing_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  oms_order_id uuid NOT NULL REFERENCES oms_order(id) ON DELETE CASCADE,
  run_number integer NOT NULL CHECK (run_number > 0),
  status text NOT NULL
    CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  strategy text NOT NULL DEFAULT 'PRIORITY_ATP',
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (oms_order_id, run_number)
);

CREATE TABLE oms_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  oms_order_id uuid NOT NULL REFERENCES oms_order(id) ON DELETE CASCADE,
  sourcing_run_id uuid NOT NULL REFERENCES oms_sourcing_run(id) ON DELETE CASCADE,
  sales_order_line_id uuid NOT NULL REFERENCES sales_order_line(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES inventory_reservation(id) ON DELETE SET NULL,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  safety_stock_milli_snapshot bigint NOT NULL DEFAULT 0
    CHECK (safety_stock_milli_snapshot >= 0),
  sourcing_priority_snapshot integer NOT NULL DEFAULT 100,
  state text NOT NULL DEFAULT 'RESERVED'
    CHECK (state IN ('PLANNED','RESERVED','RELEASED','CONSUMED','FAILED')),
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oms_allocation_order_idx
  ON oms_allocation(tenant_id, oms_order_id, sales_order_line_id);

CREATE INDEX oms_allocation_warehouse_idx
  ON oms_allocation(tenant_id, warehouse_id, state);

ALTER TABLE inventory_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE oms_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE oms_sourcing_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE oms_allocation ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'inventory_policy','oms_order','oms_sourcing_run','oms_allocation'
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
SELECT r.tenant_id, r.id, 'oms.read', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','WAREHOUSE','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'oms.manage', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','WAREHOUSE')
ON CONFLICT DO NOTHING;

COMMIT;
