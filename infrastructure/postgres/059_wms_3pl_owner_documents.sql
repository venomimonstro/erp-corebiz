BEGIN;

ALTER TABLE sales_order
  ADD COLUMN IF NOT EXISTS inventory_owner_id uuid
  REFERENCES inventory_owner(id) ON DELETE RESTRICT;

ALTER TABLE purchase_order
  ADD COLUMN IF NOT EXISTS inventory_owner_id uuid
  REFERENCES inventory_owner(id) ON DELETE RESTRICT;

ALTER TABLE goods_receipt
  ADD COLUMN IF NOT EXISTS inventory_owner_id uuid
  REFERENCES inventory_owner(id) ON DELETE RESTRICT;

ALTER TABLE inventory_reservation
  ADD COLUMN IF NOT EXISTS owner_id uuid
  REFERENCES inventory_owner(id) ON DELETE RESTRICT;

ALTER TABLE inventory_transaction
  ADD COLUMN IF NOT EXISTS owner_id uuid
  REFERENCES inventory_owner(id) ON DELETE RESTRICT;

ALTER TABLE wms_pick_allocation
  ADD COLUMN IF NOT EXISTS owner_id uuid
  REFERENCES inventory_owner(id) ON DELETE RESTRICT;

UPDATE sales_order so
SET inventory_owner_id=o.id
FROM inventory_owner o
WHERE o.tenant_id=so.tenant_id
  AND o.is_default=true
  AND o.status='ACTIVE'
  AND so.inventory_owner_id IS NULL;

UPDATE purchase_order po
SET inventory_owner_id=o.id
FROM inventory_owner o
WHERE o.tenant_id=po.tenant_id
  AND o.is_default=true
  AND o.status='ACTIVE'
  AND po.inventory_owner_id IS NULL;

UPDATE goods_receipt gr
SET inventory_owner_id=po.inventory_owner_id
FROM purchase_order po
WHERE po.tenant_id=gr.tenant_id
  AND po.id=gr.purchase_order_id
  AND gr.inventory_owner_id IS NULL;

UPDATE inventory_reservation r
SET owner_id=so.inventory_owner_id
FROM sales_order so
WHERE so.tenant_id=r.tenant_id
  AND so.id=r.sales_order_id
  AND r.owner_id IS NULL;

UPDATE inventory_transaction it
SET owner_id=o.id
FROM inventory_owner o
WHERE o.tenant_id=it.tenant_id
  AND o.is_default=true
  AND o.status='ACTIVE'
  AND it.owner_id IS NULL;

UPDATE wms_pick_allocation a
SET owner_id=r.owner_id
FROM inventory_reservation r
WHERE r.tenant_id=a.tenant_id
  AND r.id=a.reservation_id
  AND a.owner_id IS NULL;

ALTER TABLE sales_order
  ALTER COLUMN inventory_owner_id SET NOT NULL;

ALTER TABLE purchase_order
  ALTER COLUMN inventory_owner_id SET NOT NULL;

ALTER TABLE goods_receipt
  ALTER COLUMN inventory_owner_id SET NOT NULL;

ALTER TABLE inventory_reservation
  ALTER COLUMN owner_id SET NOT NULL;

ALTER TABLE inventory_transaction
  ALTER COLUMN owner_id SET NOT NULL;

ALTER TABLE wms_pick_allocation
  ALTER COLUMN owner_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS sales_order_owner_idx
  ON sales_order(tenant_id,inventory_owner_id,created_at DESC);

CREATE INDEX IF NOT EXISTS purchase_order_owner_idx
  ON purchase_order(tenant_id,inventory_owner_id,created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_reservation_owner_idx
  ON inventory_reservation(
    tenant_id,warehouse_id,owner_id,sku_id,status
  );

CREATE INDEX IF NOT EXISTS inventory_transaction_owner_idx
  ON inventory_transaction(
    tenant_id,warehouse_id,owner_id,sku_id,occurred_at DESC
  );

CREATE INDEX IF NOT EXISTS wms_pick_allocation_owner_idx
  ON wms_pick_allocation(
    tenant_id,warehouse_id,owner_id,sku_id,status
  );

COMMIT;
