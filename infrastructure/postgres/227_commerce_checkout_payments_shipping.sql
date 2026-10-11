BEGIN;

-- Verified provider payments. The SaaS merchant and each tenant seller use
-- distinct credentials. Secrets must be AES-GCM encrypted by the application.
CREATE TABLE commerce_merchant_config(
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  shop_id text NOT NULL,
  encrypted_secret text NOT NULL,
  vat_code integer NOT NULL CHECK(vat_code BETWEEN 1 AND 12),
  tax_system_code integer CHECK(tax_system_code BETWEEN 1 AND 6),
  fiscal_enabled boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,site_id)
);

CREATE TABLE commerce_delivery_method(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  code text NOT NULL CHECK(length(code) BETWEEN 1 AND 60),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 140),
  mode text NOT NULL CHECK(mode IN ('PICKUP','LOCAL_COURIER')),
  fee_minor bigint NOT NULL CHECK(fee_minor BETWEEN 0 AND 100000000),
  active boolean NOT NULL DEFAULT true,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,site_id,code),
  UNIQUE(tenant_id,site_id,id)
);
CREATE INDEX commerce_delivery_site_idx ON commerce_delivery_method(tenant_id,site_id,active);

CREATE TABLE commerce_order_delivery(
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE RESTRICT,
  method_id uuid NOT NULL REFERENCES commerce_delivery_method(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK(mode IN ('PICKUP','LOCAL_COURIER')),
  title text NOT NULL,
  fee_minor bigint NOT NULL CHECK(fee_minor>=0),
  address text,
  delivery_status text NOT NULL DEFAULT 'AWAITING_FULFILLMENT'
    CHECK(delivery_status IN ('AWAITING_FULFILLMENT','READY','SHIPPED','DELIVERED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,sales_order_id)
);

CREATE TABLE commerce_payment_intent(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK(purpose IN ('SAAS','STOREFRONT')),
  site_id uuid REFERENCES site(id) ON DELETE RESTRICT,
  sales_order_id uuid REFERENCES sales_order(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES billing_plan(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  currency char(3) NOT NULL DEFAULT 'RUB' CHECK(currency='RUB'),
  provider text NOT NULL DEFAULT 'YOOKASSA',
  provider_payment_id text UNIQUE,
  provider_idempotency_key text NOT NULL UNIQUE,
  customer_email text NOT NULL,
  confirmation_url text,
  status text NOT NULL DEFAULT 'NEW'
    CHECK(status IN ('NEW','PENDING','SUCCEEDED','CANCELED','FAILED')),
  fiscal_status text NOT NULL DEFAULT 'NOT_CONFIRMED'
    CHECK(fiscal_status IN ('NOT_CONFIRMED','PENDING','SUCCEEDED','FAILED')),
  finance_payment_id uuid REFERENCES payment(id) ON DELETE SET NULL,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose='SAAS' AND site_id IS NULL AND sales_order_id IS NULL AND plan_id IS NOT NULL)
     OR (purpose='STOREFRONT' AND site_id IS NOT NULL AND sales_order_id IS NOT NULL AND plan_id IS NULL))
);
CREATE UNIQUE INDEX commerce_payment_once_per_order_uq
 ON commerce_payment_intent(tenant_id,sales_order_id)
 WHERE purpose='STOREFRONT' AND status IN ('NEW','PENDING','SUCCEEDED');
CREATE INDEX commerce_payment_pending_idx
 ON commerce_payment_intent(status,created_at) WHERE status IN ('NEW','PENDING');

CREATE TABLE commerce_provider_event(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL REFERENCES commerce_payment_intent(id) ON DELETE CASCADE,
  provider_event_key text NOT NULL,
  provider_status text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intent_id,provider_event_key)
);

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'commerce_merchant_config','commerce_delivery_method',
    'commerce_order_delivery','commerce_payment_intent','commerce_provider_event'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',
      tbl||'_isolation',tbl);
  END LOOP;
END $$;

-- Minimal cross-tenant discovery. The caller can only supply an unpredictable
-- provider payment ID; the full intent is always read under tenant RLS.
CREATE FUNCTION corebiz_resolve_payment_tenant(p_provider_payment_id text)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $$
 SELECT i.tenant_id FROM commerce_payment_intent i
 WHERE i.provider_payment_id=p_provider_payment_id
 LIMIT 1;
$$;
REVOKE ALL ON FUNCTION corebiz_resolve_payment_tenant(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION corebiz_resolve_payment_tenant(text) TO corebiz_app;
  END IF;
END $$;

COMMIT;
