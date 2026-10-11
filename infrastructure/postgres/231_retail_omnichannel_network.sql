BEGIN;
-- Network store: one physical branch and one independent stock bucket per shop.
-- No offline financial posting or "virtual" stock: inventory_balance is canonical.
CREATE TABLE retail_location(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK(code ~ '^[A-Z0-9_-]{2,40}$'),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 160),
  address text,
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  pickup_enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,code),
  UNIQUE(tenant_id,branch_id),
  UNIQUE(tenant_id,warehouse_id),
  UNIQUE(tenant_id,id)
);
CREATE INDEX retail_location_active_idx ON retail_location(tenant_id,status);

-- A channel/order link is immutable: one physical location is responsible for
-- collecting its reserved stock, regardless of which front end took the order.
CREATE TABLE retail_order_link(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES retail_location(id) ON DELETE RESTRICT,
  sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK(channel IN ('COUNTER','CLICK_COLLECT')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
  fingerprint text NOT NULL,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,idempotency_key),
  UNIQUE(tenant_id,sales_order_id)
);
CREATE INDEX retail_order_location_idx ON retail_order_link(tenant_id,location_id,created_at DESC);

-- Each cash shift is a control record; it MUST NOT be interpreted as
-- 54-FZ receipt generation or a bank/ERP payment.
CREATE TABLE retail_cash_shift(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES retail_location(id) ON DELETE RESTRICT,
  opened_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  closed_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  opening_cash_minor bigint NOT NULL DEFAULT 0 CHECK(opening_cash_minor>=0),
  closing_cash_minor bigint CHECK(closing_cash_minor IS NULL OR closing_cash_minor>=0),
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX retail_cash_shift_one_open_uq ON retail_cash_shift(tenant_id,location_id) WHERE status='OPEN';

ALTER TABLE retail_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_order_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_cash_shift ENABLE ROW LEVEL SECURITY;
CREATE POLICY retail_location_tenant ON retail_location
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY retail_order_link_tenant ON retail_order_link
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY retail_cash_shift_tenant ON retail_cash_shift
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- Do not grant privileges implicitly to PUBLIC; app role receives DML only.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
  GRANT SELECT,INSERT,UPDATE ON retail_location,retail_order_link,retail_cash_shift TO corebiz_app;
 END IF;
END $$;
COMMIT;
