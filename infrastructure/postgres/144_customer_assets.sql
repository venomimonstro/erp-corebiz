BEGIN;

CREATE TABLE customer_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  asset_type text NOT NULL DEFAULT 'OTHER'
    CHECK (asset_type IN ('VEHICLE','EQUIPMENT','DEVICE','OTHER')),
  name text NOT NULL,
  manufacturer text,
  model text,
  identifier text,
  registration_number text,
  serial_number text,
  manufacture_year integer
    CHECK (manufacture_year IS NULL OR manufacture_year BETWEEN 1886 AND 2200),
  meter_value bigint
    CHECK (meter_value IS NULL OR meter_value >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customer_asset_party_idx
  ON customer_asset(tenant_id,party_id,status,updated_at DESC);

CREATE UNIQUE INDEX customer_asset_identifier_uq
  ON customer_asset(tenant_id,asset_type,lower(identifier))
  WHERE identifier IS NOT NULL AND status='ACTIVE';

CREATE INDEX customer_asset_registration_idx
  ON customer_asset(tenant_id,lower(registration_number))
  WHERE registration_number IS NOT NULL AND status='ACTIVE';

ALTER TABLE customer_asset ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_asset_isolation
  ON customer_asset
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

ALTER TABLE service_booking
  ADD COLUMN IF NOT EXISTS customer_asset_id uuid
  REFERENCES customer_asset(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS service_booking_asset_idx
  ON service_booking(tenant_id,customer_asset_id,starts_at DESC)
  WHERE customer_asset_id IS NOT NULL;

ALTER TABLE crm_deal
  ADD COLUMN IF NOT EXISTS customer_asset_id uuid
  REFERENCES customer_asset(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS crm_deal_asset_idx
  ON crm_deal(tenant_id,customer_asset_id,updated_at DESC)
  WHERE customer_asset_id IS NOT NULL;

COMMIT;
