BEGIN;
-- A CDEK booking is never an accounting payment or proof of physical delivery.
-- One booking per paid store order; ambiguous POST results MUST NOT be retried
-- automatically (otherwise a network timeout can issue a second consignment).
CREATE TABLE commerce_shipment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 site_id uuid NOT NULL REFERENCES site(id) ON DELETE RESTRICT,
 sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
 connection_id uuid NOT NULL REFERENCES commerce_provider_connection(id) ON DELETE RESTRICT,
 quote_id uuid NOT NULL REFERENCES commerce_shipping_quote(id) ON DELETE RESTRICT,
 provider text NOT NULL DEFAULT 'CDEK' CHECK(provider='CDEK'),
 provider_order_uuid uuid,
 provider_number text,
 payload_digest char(64) NOT NULL,
 state text NOT NULL DEFAULT 'PREPARED' CHECK(
   state IN ('PREPARED','SENDING','UNKNOWN','SUBMITTED',
             'ACCEPTED','REJECTED','IN_TRANSIT','DELIVERED','CANCELLED')),
 recipient_name text NOT NULL CHECK(length(recipient_name) BETWEEN 2 AND 160),
 recipient_phone text NOT NULL CHECK(length(recipient_phone) BETWEEN 10 AND 20),
 tariff_code integer NOT NULL CHECK(tariff_code>0),
 snapshot_amount_minor bigint NOT NULL CHECK(snapshot_amount_minor>=0),
 last_error_code text,
 submitted_at timestamptz,
 verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,sales_order_id),
 UNIQUE(tenant_id,id),
 UNIQUE(provider_order_uuid)
);
CREATE INDEX commerce_shipment_provider_lookup
 ON commerce_shipment(tenant_id,site_id,state,updated_at DESC);

ALTER TABLE commerce_shipment ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_shipment_tenant ON commerce_shipment
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
  GRANT SELECT,INSERT,UPDATE ON commerce_shipment TO corebiz_app;
 END IF;
END $$;
COMMIT;
