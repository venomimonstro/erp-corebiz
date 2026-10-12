BEGIN;
-- Each outbound API order is claimed durably before ONE provider PUT.
-- UNKNOWN is intentional after a timeout, NEVER retry the mutation blindly.
CREATE TABLE commerce_post_shipment(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id) ON DELETE RESTRICT,
  sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL REFERENCES commerce_provider_connection(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL REFERENCES commerce_post_tariff_quote(id) ON DELETE RESTRICT,
  payload_digest char(64) NOT NULL,
  state text NOT NULL DEFAULT 'SENDING' CHECK(
    state IN ('SENDING','UNKNOWN','BACKLOG','REVIEW_REQUIRED')),
  provider_order_id text CHECK(
    provider_order_id IS NULL OR provider_order_id ~ '^[0-9]{1,18}$'),
  barcode text CHECK(
    barcode IS NULL OR barcode ~ '^[0-9A-Z]{10,20}$'),
  recipient_name text NOT NULL CHECK(length(recipient_name) BETWEEN 1 AND 160),
  recipient_phone text NOT NULL CHECK(length(recipient_phone) BETWEEN 10 AND 20),
  recipient_address text NOT NULL CHECK(length(recipient_address) BETWEEN 5 AND 500),
  snapshot_amount_minor bigint NOT NULL CHECK(snapshot_amount_minor>0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  UNIQUE(tenant_id,sales_order_id),
  UNIQUE(tenant_id,id),
  UNIQUE(connection_id,provider_order_id)
);
CREATE INDEX commerce_post_shipment_status_idx
  ON commerce_post_shipment(tenant_id,site_id,state,updated_at DESC);
ALTER TABLE commerce_post_shipment ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_post_shipment_tenant ON commerce_post_shipment
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
    GRANT SELECT,INSERT,UPDATE ON commerce_post_shipment TO corebiz_app;
  END IF;
END $$;
COMMIT;
