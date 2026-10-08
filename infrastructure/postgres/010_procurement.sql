BEGIN;

CREATE TABLE purchase_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  supplier_party_id uuid NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  destination_branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  responsible_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','CONFIRMED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  currency char(3) NOT NULL DEFAULT 'RUB',
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  expected_at timestamptz,
  notes text,
  version integer NOT NULL DEFAULT 1,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_number)
);

CREATE INDEX purchase_order_status_idx
  ON purchase_order(tenant_id, status, created_at DESC);

CREATE TABLE purchase_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  ordered_quantity_milli bigint NOT NULL CHECK (ordered_quantity_milli > 0),
  received_quantity_milli bigint NOT NULL DEFAULT 0 CHECK (received_quantity_milli >= 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (received_quantity_milli <= ordered_quantity_milli)
);

CREATE INDEX purchase_order_line_order_idx
  ON purchase_order_line(tenant_id, purchase_order_id);

CREATE TABLE goods_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_order(id) ON DELETE RESTRICT,
  business_number text NOT NULL,
  status text NOT NULL DEFAULT 'POSTED'
    CHECK (status IN ('POSTED','REVERSED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  posted_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_number)
);

CREATE TABLE goods_receipt_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL REFERENCES goods_receipt(id) ON DELETE CASCADE,
  purchase_order_line_id uuid NOT NULL REFERENCES purchase_order_line(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX goods_receipt_line_receipt_idx
  ON goods_receipt_line(tenant_id, receipt_id);

ALTER TABLE purchase_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_line ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'purchase_order','purchase_order_line','goods_receipt','goods_receipt_line'
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

COMMIT;
