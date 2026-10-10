BEGIN;

CREATE TABLE party_commercial_terms (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  currency char(3) NOT NULL DEFAULT 'RUB',
  credit_limit_minor bigint CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
  payment_term_days integer NOT NULL DEFAULT 0
    CHECK (payment_term_days BETWEEN 0 AND 3650),
  default_discount_bps integer NOT NULL DEFAULT 0
    CHECK (default_discount_bps BETWEEN 0 AND 10000),
  allow_over_credit boolean NOT NULL DEFAULT false,
  notes text,
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, party_id)
);

CREATE TABLE party_sku_price (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  currency char(3) NOT NULL DEFAULT 'RUB',
  min_quantity_milli bigint NOT NULL DEFAULT 1000 CHECK (min_quantity_milli > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (tenant_id, party_id, sku_id, min_quantity_milli, valid_from)
);

CREATE INDEX party_sku_price_lookup_idx
  ON party_sku_price(
    tenant_id,party_id,sku_id,currency,min_quantity_milli DESC,valid_from DESC
  )
  WHERE status='ACTIVE';

ALTER TABLE sales_order_line
  ADD COLUMN pricing_source text NOT NULL DEFAULT 'MANUAL'
    CHECK (pricing_source IN ('MANUAL','LIST','PARTY_PRICE','DEFAULT_DISCOUNT')),
  ADD COLUMN price_rule_id uuid REFERENCES party_sku_price(id) ON DELETE SET NULL;

CREATE INDEX sales_order_line_price_rule_idx
  ON sales_order_line(tenant_id,price_rule_id)
  WHERE price_rule_id IS NOT NULL;

ALTER TABLE party_commercial_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_sku_price ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'party_commercial_terms',
    'party_sku_price'
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
