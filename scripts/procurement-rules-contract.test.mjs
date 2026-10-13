import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const src=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const migration=src("infrastructure/postgres/248_procurement_reorder_rules.sql");
const service=src("apps/api/src/modules/business/dashboard/commerce-decisions.service.ts");
const controller=src("apps/api/src/modules/business/dashboard/commerce-decisions.controller.ts");
const page=src("apps/web/app/app/commerce/page.tsx");

test("Procurement reorder rules remain tenant isolated and distinct from stock",()=>{
  assert.match(migration,/CREATE TABLE IF NOT EXISTS procurement_reorder_rule/);
  assert.match(migration,/UNIQUE\(tenant_id,sku_id\)/);
  assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
  assert.match(migration,/CREATE POLICY procurement_reorder_rule_isolation/);
  assert.match(migration,/minimum_batch_milli bigint NOT NULL DEFAULT 0/);
  assert.doesNotMatch(migration,/UPDATE inventory_balance|INSERT INTO inventory_balance/);
});
test("Demand horizon respects supplier lead time, review and already inbound supply",()=>{
  assert.match(service,/r\.lead_days\+r\.review_days ELSE 14/);
  assert.match(service,/GREATEST\(CEIL\(d\.ordered_milli\*pol\.target_days\/30\)-/);
  assert.match(service,/COALESCE\(i\.inbound_milli,0/);
  assert.match(service,/pol\.batch_milli/);
  assert.match(service,/targetDaysSku/);
  assert.match(service,/safety_stock_milli/);
  assert.match(service,/Ничего не закупается автоматически/);
});
test("Purchasing rules never bypass role scope or active SKU verification",()=>{
  assert.match(controller,/@RequirePermission\("procurement\.read"\)/);
  assert.match(controller,/@RequirePermission\("procurement\.write"\)/);
  assert.match(service,/resolveScope\(context,"procurement\.write"\)/);
  assert.match(service,/scope!=="all"/);
  assert.match(service,/s\.track_inventory=true/);
  assert.match(service,/r\.tenant_id=\$1/);
});
test("UI has explicit settings, safely rejects malformed quantities",()=>{
  assert.match(page,/const saveRule=async/);
  assert.match(page,/minimumBatchMilli:batch/);
  assert.match(page,/leadDays:lead,reviewDays:review/);
  assert.match(page,/Ничего не заказывается автоматически/);
});
