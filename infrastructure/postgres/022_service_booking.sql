BEGIN;

CREATE TABLE service_catalog_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  category text,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
  price_minor bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE service_catalog_skill_requirement (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service_catalog_item(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES service_skill(id) ON DELETE CASCADE,
  min_level integer NOT NULL DEFAULT 1 CHECK (min_level BETWEEN 1 AND 5),
  PRIMARY KEY (service_id, skill_id)
);

CREATE TABLE service_booking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  service_id uuid NOT NULL REFERENCES service_catalog_item(id) ON DELETE RESTRICT,
  branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'CONFIRMED'
    CHECK (status IN (
      'DRAFT','CONFIRMED','ARRIVED','IN_SERVICE',
      'COMPLETED','CANCELLED','NO_SHOW'
    )),
  source text NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('MANUAL','PUBLIC_SITE','PHONE','API','IMPORT')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  price_minor_snapshot bigint NOT NULL CHECK (price_minor_snapshot >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  notes text,
  idempotency_key text,
  version integer NOT NULL DEFAULT 1,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  completed_at timestamptz,
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, business_number)
);

CREATE UNIQUE INDEX service_booking_idempotency_uq
  ON service_booking(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX service_booking_calendar_idx
  ON service_booking(tenant_id, starts_at, ends_at, status);

CREATE INDEX service_booking_party_idx
  ON service_booking(tenant_id, party_id, starts_at DESC);

CREATE TABLE service_booking_resource (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES service_booking(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE RESTRICT,
  capacity_units integer NOT NULL DEFAULT 1 CHECK (capacity_units > 0),
  PRIMARY KEY (booking_id, resource_id)
);

CREATE INDEX service_booking_resource_window_idx
  ON service_booking_resource(tenant_id, resource_id, booking_id);

ALTER TABLE service_catalog_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_catalog_skill_requirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_booking_resource ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'service_catalog_item',
    'service_catalog_skill_requirement',
    'service_booking',
    'service_booking_resource'
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
