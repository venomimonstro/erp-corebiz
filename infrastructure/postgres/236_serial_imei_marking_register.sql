BEGIN;
-- Serial/IMEI register is a pre-integration inventory identity index, NOT
-- confirmation of a GISTM/ChZ marking status or a fiscal disposition.
CREATE TABLE retail_serial_unit(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 location_id uuid NOT NULL REFERENCES retail_location(id) ON DELETE RESTRICT,
 warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
 sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
 serial_number text NOT NULL CHECK(length(serial_number) BETWEEN 4 AND 100),
 imei text CHECK(imei IS NULL OR imei ~ '^[0-9]{15}$'),
 gtin text CHECK(gtin IS NULL OR gtin ~ '^[0-9]{14}$'),
 marking_product_group text,
 marking_code_hash char(64),
 marking_code_ciphertext text,
 marking_state text NOT NULL DEFAULT 'NOT_CHECKED'
   CHECK(marking_state IN ('NOT_CHECKED','VERIFIED','REJECTED')),
 stock_state text NOT NULL DEFAULT 'REGISTERED'
   CHECK(stock_state IN ('REGISTERED','RESERVED','SOLD','RETURNED','BLOCKED')),
 sales_order_id uuid REFERENCES sales_order(id) ON DELETE RESTRICT,
 created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((marking_code_hash IS NULL)=(marking_code_ciphertext IS NULL)),
 CHECK (marking_state<>'VERIFIED'),
 UNIQUE(tenant_id,serial_number),
 UNIQUE(tenant_id,id)
);
-- CHECK(marking_state<>'VERIFIED') deliberately prevents claims of official
-- verification until a real signed True API integration migration exists.
CREATE UNIQUE INDEX retail_serial_imei_uq
 ON retail_serial_unit(tenant_id,imei) WHERE imei IS NOT NULL;
CREATE UNIQUE INDEX retail_serial_mark_uq
 ON retail_serial_unit(tenant_id,marking_code_hash)
 WHERE marking_code_hash IS NOT NULL;
CREATE INDEX retail_serial_warehouse_idx
 ON retail_serial_unit(tenant_id,warehouse_id,sku_id,stock_state);

ALTER TABLE retail_serial_unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY retail_serial_unit_tenant ON retail_serial_unit
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
  GRANT SELECT,INSERT ON retail_serial_unit TO corebiz_app;
 END IF;
END $$;
COMMIT;
