BEGIN;

CREATE OR REPLACE FUNCTION corebiz_valid_weekdays(value smallint[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    value IS NOT NULL
    AND cardinality(value) BETWEEN 1 AND 7
    AND NOT EXISTS (
      SELECT 1 FROM unnest(value) AS d
      WHERE d < 1 OR d > 7
    );
$$;

ALTER TABLE service_catalog_item
  ADD COLUMN IF NOT EXISTS delivery_format text NOT NULL DEFAULT 'INDIVIDUAL',
  ADD COLUMN IF NOT EXISTS group_capacity integer NOT NULL DEFAULT 1;

ALTER TABLE service_catalog_item
  DROP CONSTRAINT IF EXISTS service_catalog_item_delivery_format_ck,
  DROP CONSTRAINT IF EXISTS service_catalog_item_group_capacity_ck;

ALTER TABLE service_catalog_item
  ADD CONSTRAINT service_catalog_item_delivery_format_ck
    CHECK (delivery_format IN ('INDIVIDUAL','GROUP','SELF_PRACTICE','RENTAL')),
  ADD CONSTRAINT service_catalog_item_group_capacity_ck
    CHECK (group_capacity BETWEEN 1 AND 100000);

CREATE TABLE service_technology_card (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  description text,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,code),
  UNIQUE (tenant_id,id)
);

CREATE TABLE service_technology_card_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES service_technology_card(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  waste_bps integer NOT NULL DEFAULT 0 CHECK (waste_bps BETWEEN 0 AND 10000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,card_id,warehouse_id,sku_id)
);

CREATE INDEX service_technology_card_line_card_idx
  ON service_technology_card_line(tenant_id,card_id);

CREATE TABLE service_delivery_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service_catalog_item(id) ON DELETE CASCADE,
  employee_resource_id uuid REFERENCES service_resource(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branch(id) ON DELETE CASCADE,
  delivery_format text NOT NULL DEFAULT 'INDIVIDUAL'
    CHECK (delivery_format IN ('INDIVIDUAL','GROUP','SELF_PRACTICE','RENTAL')),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  price_max_minor bigint CHECK (price_max_minor IS NULL OR price_max_minor >= 0),
  duration_minutes integer CHECK (
    duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 1440
  ),
  capacity_units integer NOT NULL DEFAULT 1
    CHECK (capacity_units BETWEEN 1 AND 100000),
  technology_card_id uuid
    REFERENCES service_technology_card(id) ON DELETE SET NULL,
  weekdays smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[],
  start_minute smallint NOT NULL DEFAULT 0
    CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL DEFAULT 1440
    CHECK (end_minute BETWEEN 1 AND 1440),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  valid_from date NOT NULL DEFAULT current_date,
  valid_to date,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (price_max_minor IS NULL OR price_minor IS NULL OR price_max_minor >= price_minor),
  CHECK (corebiz_valid_weekdays(weekdays)),
  UNIQUE (tenant_id,id)
);

CREATE INDEX service_delivery_rule_match_idx
  ON service_delivery_rule(
    tenant_id,service_id,status,delivery_format,employee_resource_id,
    branch_id,priority,valid_from,valid_to
  );

CREATE OR REPLACE FUNCTION corebiz_service_delivery_rule_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  IF NEW.employee_resource_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM service_resource r
    WHERE r.tenant_id=NEW.tenant_id
      AND r.id=NEW.employee_resource_id
      AND r.type='EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'SERVICE_DELIVERY_EMPLOYEE_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM service_delivery_rule x
    WHERE x.tenant_id=NEW.tenant_id
      AND x.id<>NEW.id
      AND x.status='ACTIVE'
      AND x.service_id=NEW.service_id
      AND x.delivery_format=NEW.delivery_format
      AND x.employee_resource_id IS NOT DISTINCT FROM NEW.employee_resource_id
      AND x.branch_id IS NOT DISTINCT FROM NEW.branch_id
      AND x.priority=NEW.priority
      AND daterange(x.valid_from,x.valid_to,'[]')
          && daterange(NEW.valid_from,NEW.valid_to,'[]')
      AND x.weekdays && NEW.weekdays
      AND int4range(x.start_minute::int,x.end_minute::int,'[)')
          && int4range(NEW.start_minute::int,NEW.end_minute::int,'[)')
  ) THEN
    RAISE EXCEPTION 'SERVICE_DELIVERY_RULE_AMBIGUOUS';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_delivery_rule_guard_v1 ON service_delivery_rule;
CREATE TRIGGER service_delivery_rule_guard_v1
BEFORE INSERT OR UPDATE OF
  service_id,employee_resource_id,branch_id,delivery_format,
  weekdays,start_minute,end_minute,priority,valid_from,valid_to,status
ON service_delivery_rule
FOR EACH ROW EXECUTE FUNCTION corebiz_service_delivery_rule_guard();

ALTER TABLE service_booking
  ADD COLUMN IF NOT EXISTS delivery_rule_id uuid
    REFERENCES service_delivery_rule(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS technology_card_id uuid
    REFERENCES service_technology_card(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_format_snapshot text NOT NULL DEFAULT 'INDIVIDUAL';

ALTER TABLE service_booking
  DROP CONSTRAINT IF EXISTS service_booking_delivery_format_snapshot_ck;

ALTER TABLE service_booking
  ADD CONSTRAINT service_booking_delivery_format_snapshot_ck
  CHECK (delivery_format_snapshot IN ('INDIVIDUAL','GROUP','SELF_PRACTICE','RENTAL'));

ALTER TABLE service_technology_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_technology_card_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_delivery_rule ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_technology_card_isolation
  ON service_technology_card
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY service_technology_card_line_isolation
  ON service_technology_card_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY service_delivery_rule_isolation
  ON service_delivery_rule
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER service_technology_card_line_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_technology_card_line
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'card_id','service_technology_card',
  'warehouse_id','warehouse',
  'sku_id','sku'
);

CREATE TRIGGER service_delivery_rule_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_delivery_rule
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'service_id','service_catalog_item',
  'employee_resource_id','service_resource',
  'branch_id','branch',
  'technology_card_id','service_technology_card'
);

COMMIT;
