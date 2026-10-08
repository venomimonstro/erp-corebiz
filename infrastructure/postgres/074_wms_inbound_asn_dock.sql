BEGIN;

CREATE TABLE wms_inbound_asn (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE RESTRICT,
  purchase_order_id uuid REFERENCES purchase_order(id) ON DELETE SET NULL,
  supplier_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  external_reference text,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT','SCHEDULED','ARRIVED','RECEIVING','RECEIVED','CANCELLED'
    )),
  expected_from timestamptz,
  expected_to timestamptz,
  vehicle_plate text,
  carrier_name text,
  notes text,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    expected_from IS NULL OR expected_to IS NULL OR expected_to > expected_from
  )
);

CREATE INDEX wms_inbound_asn_queue_idx
  ON wms_inbound_asn(tenant_id,warehouse_id,status,expected_from,created_at);

CREATE UNIQUE INDEX wms_inbound_asn_external_uq
  ON wms_inbound_asn(tenant_id,warehouse_id,external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE wms_inbound_asn_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  asn_id uuid NOT NULL REFERENCES wms_inbound_asn(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  expected_quantity_milli bigint NOT NULL CHECK (expected_quantity_milli > 0),
  received_quantity_milli bigint NOT NULL DEFAULT 0 CHECK (received_quantity_milli >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asn_id,sku_id),
  CHECK (received_quantity_milli <= expected_quantity_milli)
);

CREATE TABLE wms_dock_appointment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  asn_id uuid NOT NULL REFERENCES wms_inbound_asn(id) ON DELETE CASCADE,
  dock_location_id uuid NOT NULL REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  scheduled_from timestamptz NOT NULL,
  scheduled_to timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN (
      'SCHEDULED','CHECKED_IN','IN_SERVICE','COMPLETED','CANCELLED','NO_SHOW'
    )),
  driver_name text,
  driver_phone text,
  vehicle_plate text,
  checked_in_at timestamptz,
  service_started_at timestamptz,
  completed_at timestamptz,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_to > scheduled_from)
);

CREATE INDEX wms_dock_appointment_schedule_idx
  ON wms_dock_appointment(
    tenant_id,warehouse_id,dock_location_id,scheduled_from,scheduled_to,status
  );

ALTER TABLE wms_inbound_asn ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_inbound_asn_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_dock_appointment ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'wms_inbound_asn','wms_inbound_asn_line','wms_dock_appointment'
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

CREATE OR REPLACE FUNCTION corebiz_validate_inbound_asn()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM warehouse w
    WHERE w.id=NEW.warehouse_id
      AND w.tenant_id=NEW.tenant_id
      AND w.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'ASN warehouse/tenant mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_owner o
    WHERE o.id=NEW.owner_id
      AND o.tenant_id=NEW.tenant_id
      AND o.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'ASN owner/tenant mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.purchase_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM purchase_order po
    WHERE po.id=NEW.purchase_order_id
      AND po.tenant_id=NEW.tenant_id
      AND po.inventory_owner_id=NEW.owner_id
  ) THEN
    RAISE EXCEPTION 'ASN purchase order owner mismatch'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM inventory_owner o
    WHERE o.id=NEW.owner_id
      AND o.tenant_id=NEW.tenant_id
      AND o.owner_type='CLIENT'
  ) AND NOT EXISTS (
    SELECT 1 FROM warehouse_3pl_contract c
    WHERE c.tenant_id=NEW.tenant_id
      AND c.warehouse_id=NEW.warehouse_id
      AND c.owner_id=NEW.owner_id
      AND c.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'ASN requires active 3PL contract'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_inbound_asn_v1
BEFORE INSERT OR UPDATE OF
  tenant_id,warehouse_id,owner_id,purchase_order_id
ON wms_inbound_asn
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_inbound_asn();

CREATE OR REPLACE FUNCTION corebiz_validate_dock_appointment()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM wms_inbound_asn a
    JOIN warehouse_location l
      ON l.tenant_id=a.tenant_id
     AND l.warehouse_id=a.warehouse_id
     AND l.id=NEW.dock_location_id
     AND l.location_type='DOCK'
     AND l.status='ACTIVE'
    WHERE a.id=NEW.asn_id
      AND a.tenant_id=NEW.tenant_id
      AND a.warehouse_id=NEW.warehouse_id
  ) THEN
    RAISE EXCEPTION 'Dock appointment dimensions mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.status NOT IN ('CANCELLED','NO_SHOW') AND EXISTS (
    SELECT 1 FROM wms_dock_appointment d
    WHERE d.tenant_id=NEW.tenant_id
      AND d.dock_location_id=NEW.dock_location_id
      AND d.id<>COALESCE(NEW.id,'00000000-0000-0000-0000-000000000000'::uuid)
      AND d.status NOT IN ('CANCELLED','NO_SHOW','COMPLETED')
      AND tstzrange(d.scheduled_from,d.scheduled_to,'[)')
          && tstzrange(NEW.scheduled_from,NEW.scheduled_to,'[)')
  ) THEN
    RAISE EXCEPTION 'Dock time window overlaps existing appointment'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_dock_appointment_v1
BEFORE INSERT OR UPDATE OF
  tenant_id,warehouse_id,asn_id,dock_location_id,
  scheduled_from,scheduled_to,status
ON wms_dock_appointment
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_dock_appointment();

COMMIT;
