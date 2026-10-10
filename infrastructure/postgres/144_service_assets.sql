BEGIN;

CREATE TABLE service_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  asset_type text NOT NULL DEFAULT 'OTHER'
    CHECK (asset_type IN ('VEHICLE','EQUIPMENT','DEVICE','OTHER')),
  display_name text NOT NULL,
  external_key text,
  registration_number text,
  manufacturer text,
  model text,
  production_year smallint
    CHECK (production_year IS NULL OR production_year BETWEEN 1886 AND 2200),
  usage_value bigint NOT NULL DEFAULT 0 CHECK (usage_value >= 0),
  usage_unit text NOT NULL DEFAULT 'UNIT'
    CHECK (usage_unit IN ('KM','HOURS','CYCLES','UNIT')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX service_asset_external_key_uq
  ON service_asset(tenant_id, upper(external_key))
  WHERE external_key IS NOT NULL AND length(btrim(external_key)) > 0;

CREATE INDEX service_asset_party_idx
  ON service_asset(tenant_id, party_id, status, updated_at DESC);

CREATE INDEX service_asset_registration_idx
  ON service_asset(tenant_id, upper(registration_number))
  WHERE registration_number IS NOT NULL;

ALTER TABLE service_booking
  ADD COLUMN asset_id uuid REFERENCES service_asset(id) ON DELETE SET NULL;

CREATE INDEX service_booking_asset_history_idx
  ON service_booking(tenant_id, asset_id, starts_at DESC)
  WHERE asset_id IS NOT NULL;

ALTER TABLE service_asset ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_asset_isolation
  ON service_asset
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
