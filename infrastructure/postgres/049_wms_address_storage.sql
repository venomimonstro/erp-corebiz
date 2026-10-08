BEGIN;

CREATE TABLE warehouse_wms_profile (
  warehouse_id uuid PRIMARY KEY REFERENCES warehouse(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'ADDRESS'
    CHECK (mode IN ('ADDRESS','ADVANCED')),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ACTIVE','DISABLED')),
  stock_tracking_state text NOT NULL DEFAULT 'TOPOLOGY_ONLY'
    CHECK (stock_tracking_state IN ('TOPOLOGY_ONLY','LOCATION_LEDGER')),
  coordinate_unit text NOT NULL DEFAULT 'GRID'
    CHECK (coordinate_unit IN ('GRID','CM')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,warehouse_id)
);

CREATE TABLE warehouse_zone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  zone_type text NOT NULL
    CHECK (zone_type IN (
      'RECEIVING','STORAGE','PICKING','PACKING','SHIPPING',
      'QUARANTINE','RETURNS','CROSS_DOCK'
    )),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','BLOCKED','ARCHIVED')),
  x integer NOT NULL DEFAULT 0,
  y integer NOT NULL DEFAULT 0,
  width integer NOT NULL DEFAULT 1 CHECK (width > 0),
  height integer NOT NULL DEFAULT 1 CHECK (height > 0),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id,code)
);

CREATE INDEX warehouse_zone_type_idx
  ON warehouse_zone(tenant_id,warehouse_id,zone_type,status,priority);

CREATE TABLE warehouse_location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES warehouse_zone(id) ON DELETE CASCADE,
  parent_location_id uuid REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  code text NOT NULL,
  full_code text NOT NULL,
  name text,
  location_type text NOT NULL
    CHECK (location_type IN (
      'DOCK','STAGING','AISLE','RACK','SHELF','BIN','FLOOR','BUFFER'
    )),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','BLOCKED','MAINTENANCE','ARCHIVED')),
  pick_sequence integer NOT NULL DEFAULT 1000 CHECK (pick_sequence >= 0),
  allow_mixed_sku boolean NOT NULL DEFAULT true,
  allow_mixed_lot boolean NOT NULL DEFAULT true,
  max_weight_grams bigint CHECK (max_weight_grams IS NULL OR max_weight_grams > 0),
  max_volume_cm3 bigint CHECK (max_volume_cm3 IS NULL OR max_volume_cm3 > 0),
  x integer NOT NULL DEFAULT 0,
  y integer NOT NULL DEFAULT 0,
  width integer NOT NULL DEFAULT 1 CHECK (width > 0),
  height integer NOT NULL DEFAULT 1 CHECK (height > 0),
  level_no integer NOT NULL DEFAULT 0 CHECK (level_no >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id,full_code)
);

CREATE INDEX warehouse_location_zone_idx
  ON warehouse_location(tenant_id,warehouse_id,zone_id,status,pick_sequence);

CREATE INDEX warehouse_location_parent_idx
  ON warehouse_location(tenant_id,parent_location_id)
  WHERE parent_location_id IS NOT NULL;

CREATE TABLE warehouse_location_sku_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  zone_id uuid REFERENCES warehouse_zone(id) ON DELETE CASCADE,
  location_id uuid REFERENCES warehouse_location(id) ON DELETE CASCADE,
  rule_type text NOT NULL
    CHECK (rule_type IN ('ALLOW','PREFER','FORBID','FIXED_PICK')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  min_quantity_milli bigint CHECK (min_quantity_milli IS NULL OR min_quantity_milli >= 0),
  max_quantity_milli bigint CHECK (
    max_quantity_milli IS NULL OR max_quantity_milli > 0
  ),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (zone_id IS NOT NULL OR location_id IS NOT NULL),
  CHECK (
    min_quantity_milli IS NULL OR
    max_quantity_milli IS NULL OR
    min_quantity_milli <= max_quantity_milli
  )
);

CREATE INDEX warehouse_location_sku_rule_idx
  ON warehouse_location_sku_rule(
    tenant_id,warehouse_id,sku_id,rule_type,priority
  );

ALTER TABLE warehouse_wms_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_location_sku_rule ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'warehouse_wms_profile',
    'warehouse_zone',
    'warehouse_location',
    'warehouse_location_sku_rule'
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

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'wms.read','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','WAREHOUSE','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'wms.manage','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','WAREHOUSE')
ON CONFLICT DO NOTHING;

COMMIT;
