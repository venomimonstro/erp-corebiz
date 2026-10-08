BEGIN;

CREATE OR REPLACE FUNCTION corebiz_inventory_reservation_oms_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE oms_allocation
    SET state = CASE NEW.status
      WHEN 'CONSUMED' THEN 'CONSUMED'
      WHEN 'RELEASED' THEN 'RELEASED'
      WHEN 'EXPIRED' THEN 'RELEASED'
      ELSE state
    END
    WHERE tenant_id=NEW.tenant_id
      AND reservation_id=NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_reservation_oms_sync ON inventory_reservation;

CREATE TRIGGER inventory_reservation_oms_sync
AFTER UPDATE OF status ON inventory_reservation
FOR EACH ROW
EXECUTE FUNCTION corebiz_inventory_reservation_oms_sync();

CREATE OR REPLACE FUNCTION corebiz_sales_fulfillment_oms_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.fulfillment_status IS DISTINCT FROM NEW.fulfillment_status
     AND NEW.fulfillment_status = 'SHIPPED'
  THEN
    UPDATE oms_order
    SET state='SHIPPED',updated_at=now()
    WHERE tenant_id=NEW.tenant_id
      AND sales_order_id=NEW.id
      AND state <> 'CANCELLED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_fulfillment_oms_sync ON sales_order;

CREATE TRIGGER sales_fulfillment_oms_sync
AFTER UPDATE OF fulfillment_status ON sales_order
FOR EACH ROW
EXECUTE FUNCTION corebiz_sales_fulfillment_oms_sync();

UPDATE oms_allocation a
SET state = CASE r.status
  WHEN 'CONSUMED' THEN 'CONSUMED'
  WHEN 'RELEASED' THEN 'RELEASED'
  WHEN 'EXPIRED' THEN 'RELEASED'
  ELSE a.state
END
FROM inventory_reservation r
WHERE r.tenant_id=a.tenant_id
  AND r.id=a.reservation_id
  AND r.status IN ('CONSUMED','RELEASED','EXPIRED');

UPDATE oms_order oo
SET state='SHIPPED',updated_at=now()
FROM sales_order so
WHERE so.tenant_id=oo.tenant_id
  AND so.id=oo.sales_order_id
  AND so.fulfillment_status='SHIPPED'
  AND oo.state <> 'CANCELLED';

COMMIT;
