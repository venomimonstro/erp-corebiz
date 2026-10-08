-- Sprint 44e: ensure owner-consistent sales reservation and WMS allocations.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_reservation_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM sales_order so
  JOIN sales_order_line sl ON sl.order_id=so.id AND sl.tenant_id=so.tenant_id
  WHERE so.id=NEW.sales_order_id AND so.tenant_id=NEW.tenant_id
    AND so.inventory_owner_id=NEW.owner_id
    AND sl.id=NEW.sales_order_line_id
    AND sl.sku_id=NEW.sku_id
 ) THEN
  RAISE EXCEPTION 'Reservation order, line, SKU or owner mismatch'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_pick_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM inventory_reservation r
  WHERE r.id=NEW.reservation_id AND r.tenant_id=NEW.tenant_id
    AND r.sales_order_id=NEW.sales_order_id
    AND r.warehouse_id=NEW.warehouse_id
    AND r.sku_id=NEW.sku_id
    AND r.owner_id=NEW.owner_id
 ) THEN
  RAISE EXCEPTION 'Pick allocation does not match reservation owner or dimensions'
    USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM warehouse_location src
  JOIN warehouse_location dst
    ON dst.id=NEW.outbound_location_id
   AND dst.tenant_id=NEW.tenant_id
   AND dst.warehouse_id=NEW.warehouse_id
  WHERE src.id=NEW.source_location_id
    AND src.tenant_id=NEW.tenant_id
    AND src.warehouse_id=NEW.warehouse_id
 ) THEN
  RAISE EXCEPTION 'Pick allocation locations outside warehouse'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

DO $$
BEGIN
 IF EXISTS (
   SELECT 1 FROM inventory_reservation r
   LEFT JOIN sales_order so ON so.id=r.sales_order_id AND so.tenant_id=r.tenant_id
   LEFT JOIN sales_order_line sl ON sl.id=r.sales_order_line_id
      AND sl.tenant_id=r.tenant_id AND sl.order_id=r.sales_order_id
   WHERE so.id IS NULL OR so.inventory_owner_id IS DISTINCT FROM r.owner_id
      OR sl.id IS NULL OR sl.sku_id IS DISTINCT FROM r.sku_id
 ) THEN
  RAISE EXCEPTION 'Existing reservation/owner mismatches: reconcile before migration';
 END IF;
 IF EXISTS (
   SELECT 1 FROM wms_pick_allocation a
   LEFT JOIN inventory_reservation r ON r.id=a.reservation_id
      AND r.tenant_id=a.tenant_id
   LEFT JOIN warehouse_location src ON src.id=a.source_location_id
      AND src.tenant_id=a.tenant_id AND src.warehouse_id=a.warehouse_id
   LEFT JOIN warehouse_location dst ON dst.id=a.outbound_location_id
      AND dst.tenant_id=a.tenant_id AND dst.warehouse_id=a.warehouse_id
   WHERE r.id IS NULL OR r.owner_id IS DISTINCT FROM a.owner_id
      OR r.sales_order_id<>a.sales_order_id OR r.warehouse_id<>a.warehouse_id
      OR r.sku_id<>a.sku_id OR src.id IS NULL OR dst.id IS NULL
 ) THEN
  RAISE EXCEPTION 'Existing pick/owner/location mismatches: reconcile before migration';
 END IF;
END;
$$;

CREATE TRIGGER validate_3pl_reservation_owner_v1
BEFORE INSERT OR UPDATE OF tenant_id,sales_order_id,sales_order_line_id,sku_id,owner_id
ON inventory_reservation
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_3pl_reservation_owner();

CREATE TRIGGER validate_3pl_pick_owner_v1
BEFORE INSERT OR UPDATE OF tenant_id,reservation_id,sales_order_id,warehouse_id,sku_id,owner_id,source_location_id,outbound_location_id
ON wms_pick_allocation
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_3pl_pick_owner();

COMMIT;
