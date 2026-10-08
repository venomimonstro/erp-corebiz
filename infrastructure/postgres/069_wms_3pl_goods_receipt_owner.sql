-- Sprint 44g: goods receipt owner must match its purchase order.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_goods_receipt_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM purchase_order po
    WHERE po.id=NEW.purchase_order_id
      AND po.tenant_id=NEW.tenant_id
      AND po.inventory_owner_id=NEW.inventory_owner_id
  ) THEN
    RAISE EXCEPTION 'Goods receipt owner must match purchase order owner'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM goods_receipt gr
    LEFT JOIN purchase_order po
      ON po.id=gr.purchase_order_id AND po.tenant_id=gr.tenant_id
    WHERE po.id IS NULL
       OR po.inventory_owner_id IS DISTINCT FROM gr.inventory_owner_id
  ) THEN
    RAISE EXCEPTION 'Historical receipts mismatch purchase order owner; reconcile first';
  END IF;
END;
$$;

CREATE TRIGGER goods_receipt_owner_matches_purchase_v1
BEFORE INSERT OR UPDATE OF tenant_id,purchase_order_id,inventory_owner_id
ON goods_receipt
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_goods_receipt_owner();

COMMIT;
