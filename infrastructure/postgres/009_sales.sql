BEGIN;

CREATE TABLE tenant_counter (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  counter_key text NOT NULL,
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, counter_key)
);

CREATE TABLE sales_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  source_deal_id uuid REFERENCES crm_deal(id) ON DELETE SET NULL,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  responsible_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  order_status text NOT NULL DEFAULT 'DRAFT'
    CHECK (order_status IN ('DRAFT','CONFIRMED','COMPLETED','CANCELLED')),
  payment_status text NOT NULL DEFAULT 'UNPAID'
    CHECK (payment_status IN (
      'UNPAID','PARTIALLY_PAID','PAID','PARTIALLY_REFUNDED','REFUNDED'
    )),
  fulfillment_status text NOT NULL DEFAULT 'UNALLOCATED'
    CHECK (fulfillment_status IN (
      'UNALLOCATED','PARTIALLY_RESERVED','RESERVED','READY',
      'PARTIALLY_SHIPPED','SHIPPED','CANCELLED'
    )),
  currency char(3) NOT NULL DEFAULT 'RUB',
  subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  notes text,
  idempotency_key text,
  version integer NOT NULL DEFAULT 1,
  confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_number)
);

CREATE UNIQUE INDEX sales_order_idempotency_uq
  ON sales_order(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX sales_order_tenant_status_idx
  ON sales_order(tenant_id, order_status, created_at DESC);

CREATE INDEX sales_order_party_idx
  ON sales_order(tenant_id, party_id);

CREATE INDEX sales_order_deal_idx
  ON sales_order(tenant_id, source_deal_id);

CREATE TABLE sales_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
  sku_id uuid REFERENCES sku(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sales_order_line_order_idx
  ON sales_order_line(tenant_id, order_id);

ALTER TABLE tenant_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_line ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tenant_counter','sales_order','sales_order_line'
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
