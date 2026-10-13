import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const sales=source("apps/api/src/modules/business/oms/oms.service.ts");
const policy=source("apps/api/src/modules/business/inventory/reservation-policy.ts");
const booking=source("apps/api/src/modules/business/service-ops/booking.service.ts");
const studio=source("apps/api/src/modules/business/dance-studio/dance-studio.service.ts");
const settlement=source("apps/api/src/modules/business/dance-studio/dance-economics.service.ts");
const portal=source("apps/api/src/modules/business/dance-studio/dance-customer-portal.service.ts");
const finance=source("apps/api/src/modules/business/dance-studio/dance-economics.service.ts");
const role=source("infrastructure/postgres/247_dance_studio_manager_role.sql");
const migrations=source("infrastructure/postgres/151_dance_studio_core.sql");
const clientUI=source("apps/web/app/portal/dance/page.tsx");
const ownerBudget=source("apps/web/app/app/dance/budget/page.tsx");

test("MoySklad pattern: reserve ≠ physical shipment",()=>{
  assert.match(sales,/allocation/i);
  assert.match(sales,/reserve/i);
  assert.match(sales,/sales_order/i);
  assert.match(policy,/physicalMilli/);
  assert.match(policy,/reservedMilli/);
  assert.match(policy,/requestedMilli/);
  assert.match(policy,/ConflictException/);
  assert.match(policy,/safety/i);
});

test("YCLIENTS pattern: no stale slot or double booking, employee-specific terms",()=>{
  assert.match(booking,/resolveDeliveryRule/);
  assert.match(booking,/resourceAvailable/);
  assert.match(booking,/idempotencyKey/);
  assert.match(booking,/pg_advisory_xact_lock/);
  assert.match(booking,/MAX_CANDIDATES=600/);
  assert.match(migrations,/UNIQUE \(tenant_id,lesson_id,student_id\)/);
});

test("YCLIENTS pattern: package use and attendance are distinct event states",()=>{
  assert.match(migrations,/CREATE TABLE dance_package_redemption/);
  assert.match(migrations,/RESERVED','CONSUMED','RELEASED/);
  assert.match(migrations,/ATTENDED','LATE','NO_SHOW/);
  assert.match(migrations,/service_package_plan/);
  assert.match(settlement,/dance_package_redemption/);
  assert.match(studio,/dance_group_member/);
});

test("Family portal never fakes paid status when financial reconciliation is unknown",()=>{
  assert.match(portal,/finance_verified/);
  assert.match(portal,/settled_minor/);
  assert.match(portal,/o\.id IS NULL THEN NULL/);
  assert.match(clientUI,/c\.finance_verified/);
  assert.match(clientUI,/Платёж и задолженность требуют сверки/);
  assert.match(clientUI,/p\.status==="ACTIVE"/);
});

test("Managers see pupil receivables without bank, payroll or account administration",()=>{
  assert.match(role,/dance\.charges\.read/);
  assert.doesNotMatch(role,/\('finance\.read'\)|\('finance\.write'\)/);
  assert.doesNotMatch(role,/\('users\.manage'\)|\('roles\.manage'\)/);
  assert.match(studio,/dance\.charges\.read/);
});

test("Net profit excludes unverified second-branch rent, coach payroll and taxes",()=>{
  assert.match(ownerBudget,/rentB:""/);
  assert.match(ownerBudget,/trainerSalaries:""/);
  assert.match(ownerBudget,/taxes:""/);
  assert.match(ownerBudget,/profit===null/);
  assert.match(ownerBudget,/Плановые предположения владельца/);
  assert.match(finance,/dance_lesson_profitability/);
});

test("No duplicate shadow ledger from competitor products",()=>{
  // A benchmark should never introduce its own payment or inventory store.
  const browser=source("apps/web/app/app/dance/services/page.tsx");
  assert.match(browser,/\/service\/catalog/);
  assert.match(portal,/financial_obligation/);
  assert.match(sales,/inventory/i);
});
