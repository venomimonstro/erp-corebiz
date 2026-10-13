import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const file=(name)=>readFileSync(new URL("../"+name,import.meta.url),"utf8");
const ops=file("apps/api/src/modules/business/wms/wms-operations.service.ts");
const logic=file("apps/api/src/modules/business/wms/wms-operations.logic.ts");
const controller=file("apps/api/src/modules/business/wms/wms-operations.controller.ts");
const module=file("apps/api/src/modules/business/wms/wms.module.ts");
const screen=file("apps/web/app/app/wms/operations/page.tsx");
const sidebar=file("apps/web/components/app-sidebar.tsx");
const inventory=file("apps/api/src/modules/business/inventory/inventory.service.ts");
const oldWms=file("apps/api/src/modules/business/wms/wms.service.ts");

test("CoreBiz keeps ONE warehouse ledger, no parallel inventory writes",()=>{
  assert.match(ops,/LEFT JOIN inventory_balance b/);
  assert.match(ops,/FROM purchase_order_line l/);
  assert.match(ops,/po.status IN \('CONFIRMED','PARTIALLY_RECEIVED'\)/);
  assert.match(ops,/HAVING count\(\*\)=1/);
  assert.match(ops,/UNION/);
  assert.match(ops,/LEFT JOIN inventory_balance/);
  assert.match(ops,/warehouseStockIndicators/);
  assert.doesNotMatch(ops,/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+inventory_balance\b/i);
  assert.match(inventory,/async reserveOrder\(/);
  assert.match(inventory,/async shipOrder\(/);
  assert.match(inventory,/async replenishment\(/);
});

test("Promise-to-ship is separate from future incoming procurement",()=>{
  assert.match(logic,/const available=physical-reserved/);
  assert.match(logic,/const projected=available\+expected/);
  assert.match(logic,/const sellable=input.sourcingEnabled/);
  assert.match(logic,/recommendedPurchaseMilli/);
  assert.match(logic,/stockIsPhysicalOnly:true/);
  assert.match(screen,/Подтверждённая/);
  assert.match(screen,/Ожидается/);
  assert.match(screen,/Продать сейчас/);
  assert.match(screen,/requiresPagination/);
  assert.match(ops,/LIMIT 501/);
});

test("AXELOT-like path uses real WMS pick tasks and location order",()=>{
  assert.match(ops,/FROM warehouse_task t/);
  assert.match(ops,/t.task_type='PICK'/);
  assert.match(ops,/t.status IN \('OPEN','CLAIMED'\)/);
  assert.match(ops,/l.pick_sequence/);
  assert.match(ops,/t.wave_id=\$3/);
  assert.match(logic,/zonePriority-b.zonePriority/);
  assert.match(logic,/pickSequence-b.pickSequence/);
  assert.match(screen,/не расчёт кратчайшего маршрута/);
  assert.match(oldWms,/async completePick\(/);
  assert.match(oldWms,/async completeShip\(/);
  assert.match(oldWms,/async completeCycleCountTask\(/);
});

test("WMS operation endpoints are tenant scoped and RBAC protected",()=>{
  assert.match(ops,/tenant_id=\$1/);
  assert.match(ops,/warehouse_id=\$2/);
  assert.match(ops,/isUuid\(warehouseId\)/);
  assert.match(ops,/withTenantTransaction/);
  assert.match(controller,/@RequirePermission\("wms.read"\)/);
  assert.match(module,/WmsOperationsController/);
  assert.match(module,/WmsOperationsService/);
  assert.match(sidebar,/\/app\/wms\/operations/);
  assert.match(screen,/role="alert"/);
  assert.match(screen,/AppSidebar/);
});


test("Warehouse owner searches ALL SKUs using SQL keyset pagination",()=>{
  assert.match(ops,/async stockPage\(/);
  assert.match(ops,/decodeStockCursor\(input\.cursor\)/);
  assert.match(ops,/decoded\.warehouseId!==warehouseId/);
  assert.match(ops,/decoded\.query!==query/);
  assert.match(ops,/decoded\.onlyProblems!==onlyProblems/);
  assert.match(ops,/ORDER BY p\.name,s\.code,sku_set\.sku_id LIMIT \$8/);
  assert.match(ops,/rows\.rows\.slice\(0,limit\)/);
  assert.match(ops,/hasMore/);
  assert.match(ops,/stockIsPhysicalOnly:true|warehouseStockIndicators/);
  assert.match(controller,/@Get\("warehouses\/:warehouseId\/stock-page"\)/);
  assert.match(controller,/@RequirePermission\("wms\.read"\)/);
  assert.match(screen,/Показать следующие 100 SKU/);
  assert.match(screen,/stock-page\?limit=100/);
  assert.doesNotMatch(screen,/Показаны первые 500 позиций/);
});
test("Explicit destination warehouse prevents misallocated expected procurement",()=>{
  assert.match(ops,/coalesce\(po\.destination_warehouse_id,ub\.warehouse_id\)/);
  assert.equal((ops.match(/SELECT sku_id FROM inventory_policy/g)||[]).length,2,
    "Old and paged WMS views must include zero-stock policy SKUs");
  assert.match(inventory,/WITH positions AS \(/);
  assert.match(inventory,/SELECT warehouse_id,sku_id FROM inventory_policy/);
  assert.match(inventory,/COALESCE\(po\.destination_warehouse_id,t\.warehouse_id\)/);
  assert.match(inventory,/HAVING count\(\*\)=1/);
  assert.match(logic,/const available=physical-reserved/);
  assert.match(logic,/const projected=available\+expected/);
});
test("Stock shortage generates DRAFT purchase document, not phantom receipt",()=>{
  assert.match(screen,/\/procurement\/suppliers/);
  assert.match(screen,/\/procurement\/orders/);
  assert.match(screen,/supplierPartyId:supplierId/);
  assert.match(screen,/destinationWarehouseId:warehouseId/);
  assert.match(screen,/quantityMilli:selectedItem\.recommendedPurchaseMilli/);
  assert.match(screen,/purchaseAttempted/);
  assert.match(screen,/Проверьте закупки перед новой попыткой/);
  assert.doesNotMatch(screen,/\/procurement\/orders\/.*\/confirm/);
  const code=ops.slice(ops.indexOf("async stockPage("),ops.indexOf("async pickRoute("));
  assert.doesNotMatch(code,/\bINSERT INTO\b|\bUPDATE (?:inventory_balance|purchase_order)\b/i);
});
