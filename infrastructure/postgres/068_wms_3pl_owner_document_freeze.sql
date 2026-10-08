-- Sprint 44f: prohibit retroactive ownership changes to committed stock documents.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_guard_order_owner_change()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.inventory_owner_id IS DISTINCT FROM OLD.inventory_owner_id THEN
    IF EXISTS (
      SELECT 1 FROM inventory_reservation r
      WHERE r.tenant_id=OLD.tenant_id AND r.sales_order_id=OLD.id
    ) OR EXISTS (
      SELECT 1 FROM wms_pick_allocation a
      WHERE a.tenant_id=OLD.tenant_id AND a.sales_order_id=OLD.id
    ) THEN
      RAISE EXCEPTION 'Cannot change sales order owner after reservations or picks exist'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_guard_purchase_owner_change()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.inventory_owner_id IS DISTINCT FROM OLD.inventory_owner_id AND EXISTS (
    SELECT 1 FROM goods_receipt gr
    WHERE gr.tenant_id=OLD.tenant_id AND gr.purchase_order_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'Cannot change purchase order owner after goods receipt'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_sales_order_owner_change_v1
BEFORE UPDATE OF inventory_owner_id ON sales_order
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_order_owner_change();

CREATE TRIGGER guard_purchase_order_owner_change_v1
BEFORE UPDATE OF inventory_owner_id ON purchase_order
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_purchase_owner_change();

COMMIT;
