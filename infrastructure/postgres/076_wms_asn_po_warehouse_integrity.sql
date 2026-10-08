BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM wms_inbound_asn a
    JOIN purchase_order po
      ON po.tenant_id=a.tenant_id
     AND po.id=a.purchase_order_id
    WHERE a.purchase_order_id IS NOT NULL
      AND po.destination_warehouse_id IS NOT NULL
      AND po.destination_warehouse_id IS DISTINCT FROM a.warehouse_id
  ) THEN
    RAISE EXCEPTION 'Historical ASN warehouse differs from purchase order destination; reconcile first';
  END IF;
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
      AND (
        po.destination_warehouse_id IS NULL
        OR po.destination_warehouse_id=NEW.warehouse_id
      )
  ) THEN
    RAISE EXCEPTION 'ASN purchase order owner or destination warehouse mismatch'
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

COMMIT;
