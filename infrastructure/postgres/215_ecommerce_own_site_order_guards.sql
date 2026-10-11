BEGIN;
-- Mark stock for sales made on the merchant's own site, even before OMS allocation.
CREATE OR REPLACE FUNCTION corebiz_mark_sales_order_stock_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE affected record;
BEGIN
 IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status
    AND NEW.fulfillment_status IS NOT DISTINCT FROM OLD.fulfillment_status THEN
   RETURN NEW;
 END IF;
 FOR affected IN
  SELECT DISTINCT l.warehouse_id,l.sku_id FROM sales_order_line li
  JOIN channel_stock_listing l ON l.tenant_id=li.tenant_id AND l.sku_id=li.sku_id
  WHERE li.tenant_id=NEW.tenant_id AND li.order_id=NEW.id
    AND (NEW.warehouse_id IS NULL OR l.warehouse_id=NEW.warehouse_id
         OR OLD.warehouse_id IS NULL OR l.warehouse_id=OLD.warehouse_id)
 LOOP
  INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
    VALUES(NEW.tenant_id,affected.warehouse_id,affected.sku_id)
    ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now();
 END LOOP;
 RETURN NEW;
END;$$;
CREATE TRIGGER stock_hub_sales_order_changed AFTER UPDATE OF order_status,fulfillment_status
  ON sales_order FOR EACH ROW EXECUTE FUNCTION corebiz_mark_sales_order_stock_dirty();

CREATE OR REPLACE FUNCTION corebiz_mark_stock_line_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE affected record;
DECLARE v_tenant uuid;
DECLARE v_sku uuid;
DECLARE v_inbox uuid;
DECLARE v_connection uuid;
BEGIN
 IF TG_OP='DELETE' THEN
   v_tenant:=OLD.tenant_id;
   v_sku:=OLD.mapped_sku_id;
   v_inbox:=OLD.inbox_order_id;
 ELSE
   v_tenant:=NEW.tenant_id;
   v_sku:=NEW.mapped_sku_id;
   v_inbox:=NEW.inbox_order_id;
 END IF;
 IF v_sku IS NULL THEN
   SELECT o.connection_id INTO v_connection FROM channel_order_inbox o
    WHERE o.tenant_id=v_tenant AND o.id=v_inbox;
   FOR affected IN
     SELECT DISTINCT warehouse_id,sku_id FROM channel_stock_listing
     WHERE tenant_id=v_tenant AND connection_id=v_connection
   LOOP
    INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
    VALUES(v_tenant,affected.warehouse_id,affected.sku_id)
    ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now();
   END LOOP;
 ELSE
   FOR affected IN SELECT DISTINCT warehouse_id,sku_id FROM channel_stock_listing
      WHERE tenant_id=v_tenant AND sku_id=v_sku
   LOOP
    INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
    VALUES(v_tenant,affected.warehouse_id,affected.sku_id)
    ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now();
   END LOOP;
 END IF;
 IF TG_OP='UPDATE' AND OLD.mapped_sku_id IS DISTINCT FROM NEW.mapped_sku_id THEN
   IF OLD.mapped_sku_id IS NULL THEN
      SELECT o.connection_id INTO v_connection FROM channel_order_inbox o
       WHERE o.tenant_id=v_tenant AND o.id=OLD.inbox_order_id;
      FOR affected IN SELECT DISTINCT warehouse_id,sku_id FROM channel_stock_listing
          WHERE tenant_id=v_tenant AND connection_id=v_connection
      LOOP
       INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
         VALUES(v_tenant,affected.warehouse_id,affected.sku_id)
         ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now();
      END LOOP;
   ELSE
      FOR affected IN SELECT DISTINCT warehouse_id,sku_id FROM channel_stock_listing
         WHERE tenant_id=v_tenant AND sku_id=OLD.mapped_sku_id
      LOOP
       INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
         VALUES(v_tenant,affected.warehouse_id,affected.sku_id)
         ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now();
      END LOOP;
   END IF;
 END IF;
 RETURN NULL;
END;$$;
COMMIT;