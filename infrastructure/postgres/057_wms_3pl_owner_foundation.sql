BEGIN;

CREATE TABLE inventory_owner (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid REFERENCES party(id) ON DELETE RESTRICT,
  owner_type text NOT NULL
    CHECK (owner_type IN ('INTERNAL','CLIENT')),
  code text NOT NULL,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','ARCHIVED')),
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,code)
);

CREATE UNIQUE INDEX inventory_owner_party_uq
  ON inventory_owner(tenant_id,party_id)
  WHERE party_id IS NOT NULL AND status<>'ARCHIVED';

CREATE UNIQUE INDEX inventory_owner_default_uq
  ON inventory_owner(tenant_id)
  WHERE is_default=true AND status='ACTIVE';

CREATE TABLE warehouse_3pl_contract (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  services jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id,owner_id)
);

CREATE TABLE inventory_owner_balance (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  physical_milli bigint NOT NULL DEFAULT 0 CHECK (physical_milli>=0),
  reserved_milli bigint NOT NULL DEFAULT 0 CHECK (reserved_milli>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,warehouse_id,owner_id,sku_id),
  CHECK (reserved_milli<=physical_milli)
);

CREATE TABLE warehouse_location_owner_balance (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES warehouse_location(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  physical_milli bigint NOT NULL DEFAULT 0 CHECK (physical_milli>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,warehouse_id,owner_id,location_id,sku_id)
);

ALTER TABLE warehouse_wms_profile
  ADD COLUMN IF NOT EXISTS owner_tracking_state text NOT NULL DEFAULT 'TOTAL_ONLY'
  CHECK (owner_tracking_state IN ('TOTAL_ONLY','OWNER_LEDGER'));

CREATE INDEX inventory_owner_balance_sku_idx
  ON inventory_owner_balance(
    tenant_id,warehouse_id,sku_id,owner_id
  );

CREATE INDEX warehouse_location_owner_balance_sku_idx
  ON warehouse_location_owner_balance(
    tenant_id,warehouse_id,sku_id,owner_id,location_id
  );

CREATE INDEX warehouse_3pl_contract_owner_idx
  ON warehouse_3pl_contract(tenant_id,owner_id,status);

ALTER TABLE inventory_owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_3pl_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_owner_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_location_owner_balance ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'inventory_owner',
    'warehouse_3pl_contract',
    'inventory_owner_balance',
    'warehouse_location_owner_balance'
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

INSERT INTO inventory_owner(
  tenant_id,owner_type,code,name,is_default
)
SELECT
  t.id,'INTERNAL','INTERNAL','Собственный товар',true
FROM tenant t
WHERE NOT EXISTS (
  SELECT 1
  FROM inventory_owner o
  WHERE o.tenant_id=t.id
    AND o.is_default=true
    AND o.status='ACTIVE'
);

COMMIT;
