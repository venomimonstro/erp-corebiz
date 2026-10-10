BEGIN;

CREATE TABLE service_package_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  description text,
  applicable_service_id uuid REFERENCES service_catalog_item(id) ON DELETE SET NULL,
  visit_limit integer NOT NULL CHECK (visit_limit BETWEEN 1 AND 10000),
  duration_days integer NOT NULL CHECK (duration_days BETWEEN 1 AND 3650),
  price_minor bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  no_show_policy text NOT NULL DEFAULT 'RELEASE'
    CHECK (no_show_policy IN ('RELEASE','CONSUME')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE service_package (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES service_package_plan(id) ON DELETE RESTRICT,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  sales_order_id uuid REFERENCES sales_order(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  visit_limit_snapshot integer NOT NULL CHECK (visit_limit_snapshot > 0),
  reserved_visits integer NOT NULL DEFAULT 0 CHECK (reserved_visits >= 0),
  used_visits integer NOT NULL DEFAULT 0 CHECK (used_visits >= 0),
  price_minor_snapshot bigint NOT NULL CHECK (price_minor_snapshot >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','EXHAUSTED','EXPIRED','CANCELLED')),
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (reserved_visits + used_visits <= visit_limit_snapshot)
);

CREATE INDEX service_package_party_idx
  ON service_package(tenant_id, party_id, status, expires_at);

CREATE INDEX service_package_plan_idx
  ON service_package(tenant_id, plan_id, status);

CREATE TABLE service_package_redemption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES service_package(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES service_booking(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'RESERVED'
    CHECK (state IN ('RESERVED','CONSUMED','RELEASED')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (tenant_id, booking_id)
);

CREATE INDEX service_package_redemption_package_idx
  ON service_package_redemption(tenant_id, package_id, state);

ALTER TABLE service_package_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_package ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_package_redemption ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'service_package_plan',
    'service_package',
    'service_package_redemption'
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
