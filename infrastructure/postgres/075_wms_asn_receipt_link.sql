BEGIN;

ALTER TABLE goods_receipt
  ADD COLUMN IF NOT EXISTS inbound_asn_id uuid
  REFERENCES wms_inbound_asn(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS goods_receipt_asn_idx
  ON goods_receipt(tenant_id,inbound_asn_id,received_at)
  WHERE inbound_asn_id IS NOT NULL;

CREATE OR REPLACE FUNCTION corebiz_validate_goods_receipt_asn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.inbound_asn_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM wms_inbound_asn a
    JOIN purchase_order po
      ON po.tenant_id=a.tenant_id
     AND po.id=NEW.purchase_order_id
    WHERE a.id=NEW.inbound_asn_id
      AND a.tenant_id=NEW.tenant_id
      AND a.purchase_order_id=NEW.purchase_order_id
      AND a.owner_id=NEW.inventory_owner_id
      AND po.inventory_owner_id=NEW.inventory_owner_id
      AND a.status NOT IN ('CANCELLED','RECEIVED')
  ) THEN
    RAISE EXCEPTION 'Goods receipt does not match active ASN purchase order/owner'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_goods_receipt_asn_v1 ON goods_receipt;
CREATE TRIGGER validate_goods_receipt_asn_v1
BEFORE INSERT OR UPDATE OF
  tenant_id,purchase_order_id,inventory_owner_id,inbound_asn_id
ON goods_receipt
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_goods_receipt_asn();

CREATE OR REPLACE FUNCTION corebiz_apply_goods_receipt_to_asn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_asn_id uuid;
  v_remaining bigint;
BEGIN
  SELECT gr.inbound_asn_id
  INTO v_asn_id
  FROM goods_receipt gr
  WHERE gr.id=NEW.receipt_id
    AND gr.tenant_id=NEW.tenant_id;

  IF v_asn_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE wms_inbound_asn_line l
  SET received_quantity_milli=received_quantity_milli+NEW.quantity_milli,
      updated_at=now()
  WHERE l.tenant_id=NEW.tenant_id
    AND l.asn_id=v_asn_id
    AND l.sku_id=NEW.sku_id
    AND received_quantity_milli+NEW.quantity_milli<=expected_quantity_milli;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods receipt quantity exceeds ASN expectation or SKU is absent'
      USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(sum(expected_quantity_milli-received_quantity_milli),0)
  INTO v_remaining
  FROM wms_inbound_asn_line
  WHERE tenant_id=NEW.tenant_id
    AND asn_id=v_asn_id;

  UPDATE wms_inbound_asn
  SET status=CASE
        WHEN v_remaining=0 THEN 'RECEIVED'
        ELSE 'RECEIVING'
      END,
      updated_at=now()
  WHERE tenant_id=NEW.tenant_id
    AND id=v_asn_id
    AND status<>'CANCELLED';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apply_goods_receipt_to_asn_v1 ON goods_receipt_line;
CREATE TRIGGER apply_goods_receipt_to_asn_v1
AFTER INSERT ON goods_receipt_line
FOR EACH ROW EXECUTE FUNCTION corebiz_apply_goods_receipt_to_asn();

COMMIT;
