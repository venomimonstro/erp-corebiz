BEGIN;

CREATE TABLE automotive_vehicle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  service_asset_id uuid REFERENCES service_asset(id) ON DELETE SET NULL,
  vin text,
  plate_number text,
  make text NOT NULL,
  model text NOT NULL,
  generation text,
  production_year integer CHECK (production_year IS NULL OR production_year BETWEEN 1900 AND 2100),
  engine_code text,
  engine_volume_cc integer CHECK (engine_volume_cc IS NULL OR engine_volume_cc>0),
  fuel_type text,
  transmission text,
  drivetrain text,
  mileage_km integer CHECK (mileage_km IS NULL OR mileage_km>=0),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE','SOLD','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,vin),
  UNIQUE(tenant_id,service_asset_id)
);

CREATE INDEX automotive_vehicle_party_idx
  ON automotive_vehicle(tenant_id,party_id,status);
CREATE INDEX automotive_vehicle_lookup_idx
  ON automotive_vehicle(tenant_id,make,model,production_year);

CREATE TABLE automotive_work_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES automotive_vehicle(id) ON DELETE RESTRICT,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  service_booking_id uuid REFERENCES service_booking(id) ON DELETE SET NULL,
  sales_order_id uuid REFERENCES sales_order(id) ON DELETE SET NULL,
  business_number text NOT NULL,
  complaint text,
  diagnosis text,
  authorization_limit_minor bigint CHECK(authorization_limit_minor IS NULL OR authorization_limit_minor>=0),
  estimated_total_minor bigint NOT NULL DEFAULT 0 CHECK(estimated_total_minor>=0),
  actual_total_minor bigint NOT NULL DEFAULT 0 CHECK(actual_total_minor>=0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  mileage_in_km integer CHECK(mileage_in_km IS NULL OR mileage_in_km>=0),
  mileage_out_km integer CHECK(mileage_out_km IS NULL OR mileage_out_km>=0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN (
      'DRAFT','DIAGNOSIS','WAITING_APPROVAL','WAITING_PARTS',
      'IN_PROGRESS','QUALITY_CHECK','READY','DELIVERED','CANCELLED'
    )),
  promised_at timestamptz,
  completed_at timestamptz,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,business_number)
);

CREATE INDEX automotive_work_order_status_idx
  ON automotive_work_order(tenant_id,status,promised_at);
CREATE INDEX automotive_work_order_vehicle_idx
  ON automotive_work_order(tenant_id,vehicle_id,created_at DESC);

CREATE TABLE automotive_work_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL REFERENCES automotive_work_order(id) ON DELETE CASCADE,
  line_type text NOT NULL CHECK(line_type IN ('LABOR','PART','MATERIAL','OTHER')),
  service_id uuid REFERENCES service_catalog_item(id) ON DELETE SET NULL,
  sku_id uuid REFERENCES sku(id) ON DELETE SET NULL,
  employee_resource_id uuid REFERENCES service_resource(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity_milli bigint NOT NULL DEFAULT 1000 CHECK(quantity_milli>0),
  unit_price_minor bigint NOT NULL DEFAULT 0 CHECK(unit_price_minor>=0),
  unit_cost_minor bigint NOT NULL DEFAULT 0 CHECK(unit_cost_minor>=0),
  approved boolean NOT NULL DEFAULT false,
  completed boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automotive_work_order_line_order_idx
  ON automotive_work_order_line(tenant_id,work_order_id,line_type);

CREATE TABLE automotive_part_fitment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  make text NOT NULL,
  model text NOT NULL,
  generation text,
  year_from integer,
  year_to integer,
  engine_code text,
  oem_number text,
  fitment_source text NOT NULL DEFAULT 'MANUAL'
    CHECK(fitment_source IN ('MANUAL','OEM_CATALOG','SUPPLIER','IMPORT')),
  confidence_bps integer NOT NULL DEFAULT 10000 CHECK(confidence_bps BETWEEN 0 AND 10000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(year_to IS NULL OR year_from IS NULL OR year_to>=year_from)
);

CREATE INDEX automotive_part_fitment_lookup_idx
  ON automotive_part_fitment(
    tenant_id,make,model,generation,year_from,year_to,engine_code
  );
CREATE INDEX automotive_part_fitment_sku_idx
  ON automotive_part_fitment(tenant_id,sku_id);

CREATE TABLE automotive_donor_vehicle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vin text,
  stock_number text NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  generation text,
  production_year integer,
  engine_code text,
  purchase_price_minor bigint NOT NULL DEFAULT 0 CHECK(purchase_price_minor>=0),
  dismantling_cost_minor bigint NOT NULL DEFAULT 0 CHECK(dismantling_cost_minor>=0),
  status text NOT NULL DEFAULT 'RECEIVED'
    CHECK(status IN ('RECEIVED','DISMANTLING','DISMANTLED','DISPOSED','ARCHIVED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  dismantled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,stock_number),
  UNIQUE(tenant_id,vin)
);

CREATE TABLE automotive_dismantled_part (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  donor_vehicle_id uuid NOT NULL REFERENCES automotive_donor_vehicle(id) ON DELETE RESTRICT,
  sku_id uuid REFERENCES sku(id) ON DELETE SET NULL,
  part_name text NOT NULL,
  oem_number text,
  condition_grade text NOT NULL DEFAULT 'USED_B'
    CHECK(condition_grade IN ('NEW','USED_A','USED_B','USED_C','FOR_REPAIR','SCRAP')),
  serial_number text,
  warehouse_id uuid REFERENCES warehouse(id) ON DELETE SET NULL,
  quantity_milli bigint NOT NULL DEFAULT 1000 CHECK(quantity_milli>0),
  allocated_cost_minor bigint NOT NULL DEFAULT 0 CHECK(allocated_cost_minor>=0),
  asking_price_minor bigint NOT NULL DEFAULT 0 CHECK(asking_price_minor>=0),
  status text NOT NULL DEFAULT 'AVAILABLE'
    CHECK(status IN ('AVAILABLE','RESERVED','SOLD','INSTALLED','SCRAPPED','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automotive_dismantled_part_stock_idx
  ON automotive_dismantled_part(tenant_id,status,warehouse_id,part_name);
CREATE INDEX automotive_dismantled_part_oem_idx
  ON automotive_dismantled_part(tenant_id,oem_number,status);

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'automotive_vehicle','automotive_work_order','automotive_work_order_line',
    'automotive_part_fitment','automotive_donor_vehicle','automotive_dismantled_part'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',
      tbl||'_isolation',tbl
    );
  END LOOP;
END;
$$;

COMMIT;
