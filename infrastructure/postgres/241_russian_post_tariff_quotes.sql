BEGIN;
-- Quoted Russian Post rates are NOT prepaid labels or accepted consignments.
-- Postal indexes are text to preserve leading zeroes.
CREATE TABLE commerce_post_tariff_quote(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL REFERENCES commerce_provider_connection(id)
    ON DELETE RESTRICT,
  from_postcode char(6) NOT NULL CHECK(from_postcode ~ '^[0-9]{6}$'),
  to_postcode char(6) NOT NULL CHECK(to_postcode ~ '^[0-9]{6}$'),
  mail_type text NOT NULL CHECK(mail_type IN ('POSTAL_PARCEL')),
  mass_grams integer NOT NULL CHECK(mass_grams BETWEEN 1 AND 20000),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  base_rate_minor bigint NOT NULL CHECK(base_rate_minor>=0),
  vat_minor bigint NOT NULL CHECK(vat_minor>=0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  CHECK(amount_minor=base_rate_minor+vat_minor)
);
CREATE INDEX commerce_post_quote_site_idx
 ON commerce_post_tariff_quote(tenant_id,site_id,expires_at DESC);
ALTER TABLE commerce_post_tariff_quote ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_post_quote_tenant ON commerce_post_tariff_quote
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
    GRANT SELECT,INSERT ON commerce_post_tariff_quote TO corebiz_app;
  END IF;
END $$;
COMMIT;
