BEGIN;

CREATE TABLE storefront_config (
  site_id uuid PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  responsible_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL DEFAULT 'RUB',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storefront_cart (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  public_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','CHECKED_OUT','EXPIRED','ABANDONED')),
  sales_order_id uuid REFERENCES sales_order(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storefront_cart_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cart_id uuid NOT NULL REFERENCES storefront_cart(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id,sku_id)
);

CREATE INDEX storefront_cart_site_idx
  ON storefront_cart(tenant_id,site_id,status,updated_at DESC);

ALTER TABLE storefront_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_cart ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_cart_line ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'storefront_config','storefront_cart','storefront_cart_line'
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

CREATE OR REPLACE FUNCTION corebiz_resolve_public_storefront(p_site_code text)
RETURNS TABLE(
  site_id uuid,
  tenant_id uuid,
  responsible_membership_id uuid,
  currency char(3)
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id,s.tenant_id,c.responsible_membership_id,c.currency
  FROM site s
  JOIN storefront_config c
    ON c.tenant_id=s.tenant_id AND c.site_id=s.id
  WHERE s.code=p_site_code
    AND s.status='ACTIVE'
    AND c.enabled=true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_public_storefront(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_resolve_public_cart(p_public_key text)
RETURNS TABLE(
  cart_id uuid,
  tenant_id uuid,
  site_id uuid,
  status text,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id,tenant_id,site_id,status,expires_at
  FROM storefront_cart
  WHERE public_key=p_public_key
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_public_cart(text) FROM PUBLIC;

COMMIT;
