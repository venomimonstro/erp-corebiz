BEGIN;

DROP TRIGGER IF EXISTS automotive_vehicle_tenant_refs_v1 ON automotive_vehicle;
CREATE TRIGGER automotive_vehicle_tenant_refs_v1
BEFORE INSERT OR UPDATE ON automotive_vehicle
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'party_id','party',
  'service_asset_id','service_asset'
);

DROP TRIGGER IF EXISTS automotive_work_order_tenant_refs_v1 ON automotive_work_order;
CREATE TRIGGER automotive_work_order_tenant_refs_v1
BEFORE INSERT OR UPDATE ON automotive_work_order
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'vehicle_id','automotive_vehicle',
  'party_id','party',
  'service_booking_id','service_booking',
  'sales_order_id','sales_order',
  'created_by_membership_id','tenant_membership'
);

DROP TRIGGER IF EXISTS automotive_work_order_line_tenant_refs_v1
  ON automotive_work_order_line;
CREATE TRIGGER automotive_work_order_line_tenant_refs_v1
BEFORE INSERT OR UPDATE ON automotive_work_order_line
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'work_order_id','automotive_work_order',
  'service_id','service_catalog_item',
  'sku_id','sku',
  'employee_resource_id','service_resource'
);

DROP TRIGGER IF EXISTS automotive_part_fitment_tenant_refs_v1
  ON automotive_part_fitment;
CREATE TRIGGER automotive_part_fitment_tenant_refs_v1
BEFORE INSERT OR UPDATE ON automotive_part_fitment
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'sku_id','sku'
);

DROP TRIGGER IF EXISTS automotive_dismantled_part_tenant_refs_v1
  ON automotive_dismantled_part;
CREATE TRIGGER automotive_dismantled_part_tenant_refs_v1
BEFORE INSERT OR UPDATE ON automotive_dismantled_part
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'donor_vehicle_id','automotive_donor_vehicle',
  'sku_id','sku',
  'warehouse_id','warehouse'
);

CREATE OR REPLACE FUNCTION corebiz_automotive_work_order_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  vehicle_party uuid;
BEGIN
  SELECT party_id
  INTO vehicle_party
  FROM automotive_vehicle
  WHERE tenant_id=NEW.tenant_id AND id=NEW.vehicle_id;

  IF vehicle_party IS NOT NULL
     AND NEW.party_id IS NOT NULL
     AND vehicle_party<>NEW.party_id THEN
    RAISE EXCEPTION 'AUTOMOTIVE_WORK_ORDER_PARTY_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.mileage_in_km IS NOT NULL
     AND NEW.mileage_out_km IS NOT NULL
     AND NEW.mileage_out_km<NEW.mileage_in_km THEN
    RAISE EXCEPTION 'AUTOMOTIVE_MILEAGE_REGRESSION'
      USING ERRCODE='23514';
  END IF;

  IF NEW.status='DELIVERED' AND NEW.completed_at IS NULL THEN
    NEW.completed_at:=now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automotive_work_order_guard_v1
  ON automotive_work_order;
CREATE TRIGGER automotive_work_order_guard_v1
BEFORE INSERT OR UPDATE ON automotive_work_order
FOR EACH ROW EXECUTE FUNCTION corebiz_automotive_work_order_guard();

CREATE OR REPLACE FUNCTION corebiz_automotive_work_order_recalculate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  target_tenant uuid;
  target_order uuid;
BEGIN
  target_tenant:=coalesce(NEW.tenant_id,OLD.tenant_id);
  target_order:=coalesce(NEW.work_order_id,OLD.work_order_id);

  UPDATE automotive_work_order o
  SET
    estimated_total_minor=coalesce((
      SELECT sum((l.unit_price_minor*l.quantity_milli+999)/1000)
      FROM automotive_work_order_line l
      WHERE l.tenant_id=o.tenant_id
        AND l.work_order_id=o.id
        AND l.approved=true
    ),0),
    actual_total_minor=coalesce((
      SELECT sum((l.unit_price_minor*l.quantity_milli+999)/1000)
      FROM automotive_work_order_line l
      WHERE l.tenant_id=o.tenant_id
        AND l.work_order_id=o.id
        AND l.approved=true
        AND l.completed=true
    ),0),
    updated_at=now()
  WHERE o.tenant_id=target_tenant AND o.id=target_order;

  RETURN coalesce(NEW,OLD);
END;
$$;

DROP TRIGGER IF EXISTS automotive_work_order_recalculate_v1
  ON automotive_work_order_line;
CREATE TRIGGER automotive_work_order_recalculate_v1
AFTER INSERT OR UPDATE OR DELETE ON automotive_work_order_line
FOR EACH ROW EXECUTE FUNCTION corebiz_automotive_work_order_recalculate();

COMMIT;
