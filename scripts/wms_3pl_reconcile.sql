-- Read-only 3PL reconciliation for a selected tenant.
-- Execute under an authorized tenant-scoped database session with app.tenant_id set.
-- Zero returned rows = no aggregate/owner mismatch for OWNER_LEDGER warehouses.
-- Do not use as a repair script.

WITH enabled AS (
  SELECT tenant_id, warehouse_id
  FROM warehouse_wms_profile
  WHERE owner_tracking_state = 'OWNER_LEDGER'
),
aggregate_inventory AS (
  SELECT b.tenant_id,b.warehouse_id,b.sku_id,
         b.physical_milli,b.reserved_milli
  FROM inventory_balance b
  JOIN enabled e USING (tenant_id,warehouse_id)
),
owner_inventory AS (
  SELECT b.tenant_id,b.warehouse_id,b.sku_id,
         sum(b.physical_milli)::bigint AS physical_milli,
         sum(b.reserved_milli)::bigint AS reserved_milli
  FROM inventory_owner_balance b
  JOIN enabled e USING (tenant_id,warehouse_id)
  GROUP BY b.tenant_id,b.warehouse_id,b.sku_id
),
owner_vs_inventory AS (
  SELECT coalesce(a.tenant_id,o.tenant_id) AS tenant_id,
         coalesce(a.warehouse_id,o.warehouse_id) AS warehouse_id,
         coalesce(a.sku_id,o.sku_id) AS sku_id,
         'INVENTORY_OWNER'::text AS mismatch_type,
         coalesce(a.physical_milli,0) AS actual_physical,
         coalesce(o.physical_milli,0) AS owner_physical,
         coalesce(a.reserved_milli,0) AS actual_reserved,
         coalesce(o.reserved_milli,0) AS owner_reserved
  FROM aggregate_inventory a
  FULL JOIN owner_inventory o USING (tenant_id,warehouse_id,sku_id)
  WHERE coalesce(a.physical_milli,0) <> coalesce(o.physical_milli,0)
     OR coalesce(a.reserved_milli,0) <> coalesce(o.reserved_milli,0)
),
aggregate_locations AS (
  SELECT l.tenant_id,l.warehouse_id,l.location_id,l.sku_id,
         l.physical_milli
  FROM warehouse_location_balance l
  JOIN enabled e USING (tenant_id,warehouse_id)
),
owner_locations AS (
  SELECT l.tenant_id,l.warehouse_id,l.location_id,l.sku_id,
         sum(l.physical_milli)::bigint AS physical_milli
  FROM warehouse_location_owner_balance l
  JOIN enabled e USING (tenant_id,warehouse_id)
  GROUP BY l.tenant_id,l.warehouse_id,l.location_id,l.sku_id
)
SELECT tenant_id,warehouse_id,sku_id,mismatch_type,
       actual_physical,owner_physical,actual_reserved,owner_reserved
FROM owner_vs_inventory
UNION ALL
SELECT coalesce(a.tenant_id,o.tenant_id),
       coalesce(a.warehouse_id,o.warehouse_id),
       coalesce(a.sku_id,o.sku_id),
       'LOCATION_OWNER:'||coalesce(a.location_id,o.location_id)::text,
       coalesce(a.physical_milli,0),
       coalesce(o.physical_milli,0),
       0::bigint,0::bigint
FROM aggregate_locations a
FULL JOIN owner_locations o
 USING (tenant_id,warehouse_id,location_id,sku_id)
WHERE coalesce(a.physical_milli,0) <> coalesce(o.physical_milli,0)
ORDER BY warehouse_id,sku_id,mismatch_type;
