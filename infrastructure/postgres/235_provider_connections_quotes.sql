BEGIN;
-- Separate tenant/site merchant credentials. CDEK rates and ATOL FFD 1.2
-- verification do not by themselves authorize buyer checkout or claim fiscal GO.
CREATE TABLE commerce_provider_connection (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('CDEK','ATOL_ONLINE','POCHTA_RUSSIA','EVOTOR')),
 environment text NOT NULL CHECK(environment IN ('SANDBOX','PRODUCTION')),
 encrypted_credentials text NOT NULL,
 public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL DEFAULT 'CONFIGURED_UNVERIFIED' CHECK(
   state IN ('CONFIGURED_UNVERIFIED','VERIFIED','DEGRADED','DISABLED')),
 verified_at timestamptz,
 last_error_code text,
 enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,site_id,provider),
 UNIQUE(tenant_id,id)
);
CREATE INDEX commerce_provider_state_idx ON commerce_provider_connection
 (tenant_id,provider,state) WHERE enabled=true;

CREATE TABLE commerce_shipping_quote (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 site_id uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL REFERENCES commerce_provider_connection(id) ON DELETE RESTRICT,
 provider text NOT NULL CHECK(provider IN ('CDEK','POCHTA_RUSSIA')),
 from_city_code integer NOT NULL CHECK(from_city_code>0),
 to_city_code integer NOT NULL CHECK(to_city_code>0),
 package_weight_grams integer NOT NULL CHECK(package_weight_grams BETWEEN 1 AND 100000),
 tariff_code integer NOT NULL CHECK(tariff_code>0),
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 currency char(3) NOT NULL DEFAULT 'RUB' CHECK(currency='RUB'),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
CREATE INDEX commerce_shipping_quote_site_idx
 ON commerce_shipping_quote(tenant_id,site_id,expires_at DESC);

ALTER TABLE commerce_provider_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_shipping_quote ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_provider_connection_isolation
 ON commerce_provider_connection
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY commerce_shipping_quote_isolation
 ON commerce_shipping_quote
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
   GRANT SELECT,INSERT,UPDATE ON commerce_provider_connection TO corebiz_app;
   GRANT SELECT,INSERT ON commerce_shipping_quote TO corebiz_app;
 END IF;
END $$;
COMMIT;
