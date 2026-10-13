import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=(name)=>readFileSync(new URL("../"+name,import.meta.url),"utf8");
const service=read("apps/api/src/modules/business/wms/wms.service.ts");
const controller=read("apps/api/src/modules/business/wms/wms.controller.ts");
const migration=read("infrastructure/postgres/248_wms_count_variance_review.sql");
const approvals=read("infrastructure/postgres/249_wms_count_approval_permission.sql");
const screen=read("apps/web/app/app/wms/operations/page.tsx");
const inventory=read("apps/api/src/modules/business/inventory/inventory.service.ts");

test("Physical discrepancies are proposals, never posted by the counter",()=>{
  const from=service.indexOf("  async completeCycleCountTask(");
  const to=service.indexOf("  async countVariances(",from);
  assert.ok(from>=0&&to>from);
  const count=service.slice(from,to);
  assert.match(count,/REVIEW_REQUIRED/);
  assert.match(count,/counted_by_membership_id/);
  assert.match(count,/counted.toString\(\)/);
  assert.doesNotMatch(count,/applyWmsCountAdjustment\(/);
  assert.doesNotMatch(count,/INSERT INTO wms_location_movement/);
  assert.doesNotMatch(count,/UPDATE warehouse_location_balance/);
  assert.match(count,/bool_or\(status='OPEN'\)/);
  assert.match(count,/bool_or\(status='REVIEW_REQUIRED'\)/);
});
test("Migration preserves already-posted counts and tenant-level RLS",()=>{
  assert.match(migration,/ALTER TABLE wms_cycle_count_line/);
  assert.match(migration,/REVIEW_REQUIRED/);
  assert.match(migration,/counted_by_membership_id/);
  assert.match(migration,/reviewed_by_membership_id/);
  assert.match(migration,/CREATE INDEX IF NOT EXISTS wms_count_review_queue/);
  assert.doesNotMatch(migration,/TRUNCATE|DROP TABLE|DISABLE ROW LEVEL SECURITY/i);
});
test("A separate reviewer posts exact physical and location ledger together",()=>{
  const review=service.slice(service.indexOf("  async reviewCountVariance("),
    service.indexOf("  async planReplenishment("));
  assert.match(review,/row\.counted_by_membership_id===context\.membershipId/);
  assert.match(review,/FOR UPDATE OF l,c/);
  assert.match(review,/FOR UPDATE/);
  assert.match(review,/applyWmsCountAdjustment\(client,context/);
  assert.match(review,/UPDATE warehouse_location_balance/);
  assert.match(review,/INSERT INTO wms_location_movement/);
  assert.match(review,/countLineId:lineId/);
  assert.match(review,/idempotencyKey:"wms-count-adjust:"\+lineId/);
  assert.match(review,/await this\.assertLocationReconciliation/);
  assert.match(inventory,/nextPhysical<0n\|\|nextPhysical<reserved/);
  assert.match(review,/row\.status==="POSTED"/);
  assert.match(review,/review_note/);
});
test("Recount reopens the task without modifying stock",()=>{
  const review=service.slice(service.indexOf("  async reviewCountVariance("),
    service.indexOf("  async planReplenishment("));
  const from=review.indexOf('if(input.decision==="RECOUNT")');
  const to=review.indexOf("      const profile=await client.query",from);
  assert.ok(from>=0&&to>from);
  const recount=review.slice(from,to);
  assert.match(recount,/UPDATE warehouse_task/);
  assert.match(recount,/status='OPEN'/);
  assert.match(recount,/claimed_by_membership_id=NULL/);
  assert.doesNotMatch(recount,/applyWmsCountAdjustment|UPDATE warehouse_location_balance/);
});
test("Permission-guarded review endpoints visible to user",()=>{
  assert.match(controller,/@Get\("warehouses\/:warehouseId\/count-variances"\)\s+@RequirePermission\("wms.count.approve"\)/);
  assert.match(controller,/@Post\("count-lines\/:lineId\/review"\)\s+@RequirePermission\("wms.count.approve"\)/);
  assert.match(screen,/count-variances/);
  assert.match(screen,/Утвердить разницу/);
  assert.match(screen,/Пересчитать заново/);
  assert.match(screen,/countPending/);
  assert.match(approvals,/wms\\.count\\.approve/);
  assert.match(approvals,/code='ADMIN'/);
  assert.doesNotMatch(approvals,/code='WAREHOUSE'/);
});
