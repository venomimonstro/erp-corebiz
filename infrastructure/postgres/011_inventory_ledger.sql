BEGIN;

CREATE TABLE warehouse (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  name text NOT NULL,
  code text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE UNIQUE INDEX warehouse_one_default_uq
  ON warehouse(tenant_id)
  WHERE is_default = true AND status = 'ACTIVE';

ALTER TABLE sales_order
  ADD COLUMN warehouse_id uuid REFERENCES warehouse(id) ON DELETE SET NULL;

ALTER TABLE purchase_order
  ADD COLUMN destination_warehouse_id uuid REFERENCES warehouse(id) ON DELETE SET NULL;

CREATE TABLE inventory_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  movement_type text NOT NULL
    CHECK (movement_type IN (
      'RECEIPT','SHIPMENT','TRANSFER_IN','TRANSFER_OUT',
      'RETURN','ADJUSTMENT','DAMAGE','WRITE_OFF'
    )),
  quantity_delta_milli bigint NOT NULL
    CHECK (quantity_delta_milli <> 0),
  unit_cost_minor bigint CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  source_type text,
  source_id uuid,
  source_line_id uuid,
  reason text,
  idempotency_key text,
  actor_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inventory_transaction_idempotency_uq
  ON inventory_transaction(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX inventory_transaction_lookup_idx
  ON inventory_transaction(tenant_id, warehouse_id, sku_id, occurred_at DESC);

CREATE INDEX inventory_transaction_source_idx
  ON inventory_transaction(tenant_id, source_type, source_id);

CREATE TABLE inventory_balance (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  physical_milli bigint NOT NULL DEFAULT 0 CHECK (physical_milli >= 0),
  reserved_milli bigint NOT NULL DEFAULT 0 CHECK (reserved_milli >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, warehouse_id, sku_id),
  CHECK (reserved_milli <= physical_milli)
);

CREATE INDEX inventory_balance_sku_idx
  ON inventory_balance(tenant_id, sku_id);

CREATE TABLE inventory_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
  sales_order_line_id uuid NOT NULL REFERENCES sales_order_line(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RELEASED','CONSUMED','EXPIRED')),
  expires_at timestamptz,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  consumed_at timestamptz
);

CREATE UNIQUE INDEX inventory_reservation_active_line_warehouse_uq
  ON inventory_reservation(tenant_id, sales_order_line_id, warehouse_id)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX inventory_reservation_idempotency_uq
  ON inventory_reservation(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE stock_count (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  business_number text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','IN_PROGRESS','POSTED','CANCELLED')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  posted_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_number)
);

CREATE TABLE stock_count_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  stock_count_id uuid NOT NULL REFERENCES stock_count(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  expected_milli bigint NOT NULL CHECK (expected_milli >= 0),
  counted_milli bigint CHECK (counted_milli IS NULL OR counted_milli >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stock_count_id, sku_id)
);

ALTER TABLE warehouse ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_line ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'warehouse','inventory_transaction','inventory_balance',
    'inventory_reservation','stock_count','stock_count_line'
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

CREATE OR REPLACE FUNCTION corebiz_inventory_transaction_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_transaction is immutable';
END;
$$;

CREATE TRIGGER inventory_transaction_no_update
BEFORE UPDATE OR DELETE ON inventory_transaction
FOR EACH ROW
EXECUTE FUNCTION corebiz_inventory_transaction_immutable();

CREATE OR REPLACE FUNCTION corebiz_seed_default_warehouse(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO warehouse(tenant_id, name, code, is_default)
  VALUES (p_tenant_id, 'Основной склад', 'MAIN', true)
  ON CONFLICT (tenant_id, code) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_default_warehouse(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_warehouse_bootstrap_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_default_warehouse(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_warehouse
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_warehouse_bootstrap_trigger();

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM corebiz_seed_default_warehouse(t.id);
  END LOOP;
END;
$$;

UPDATE sales_order o
SET warehouse_id = w.id
FROM warehouse w
WHERE w.tenant_id = o.tenant_id
  AND w.is_default = true
  AND w.status = 'ACTIVE'
  AND o.warehouse_id IS NULL;

UPDATE purchase_order po
SET destination_warehouse_id = w.id
FROM warehouse w
WHERE w.tenant_id = po.tenant_id
  AND w.is_default = true
  AND w.status = 'ACTIVE'
  AND po.destination_warehouse_id IS NULL;

COMMIT;
