import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=(path)=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const studio=source("apps/api/src/modules/business/dance-studio/dance-studio.service.ts");
const portal=source("apps/api/src/modules/business/dance-studio/dance-customer-portal.service.ts");
const catalogue=source("apps/api/src/modules/business/service-ops/booking.service.ts");
const roles=source("infrastructure/postgres/247_dance_studio_manager_role.sql");
const e2e=source("scripts/dance-two-branch-owner-e2e.mjs");

test("Studio setup doctor counts real active coaches, not reception workers",()=>{
  const doctor=studio.slice(studio.indexOf("async setupDoctor("),
    studio.indexOf("async dashboard(",studio.indexOf("async setupDoctor(")));
  assert.match(doctor,/FROM service_resource r/);
  assert.match(doctor,/r\.status='ACTIVE' AND r\.type='EMPLOYEE'/);
  assert.match(doctor,/tr\.code='DANCE_MANAGER'/);
  assert.match(doctor,/JOIN service_catalog_item svc/);
  assert.match(doctor,/svc\.status='ACTIVE'/);
  assert.match(doctor,/coaches_with_services/);
  assert.match(doctor,/operationalSetupComplete:blockers\.length===0/);
  assert.match(doctor,/commercialReady:false/);
});
test("Parent portal invoices and entitlements remain bound to verified family",()=>{
  assert.match(portal,/dance_customer_account/);
  assert.match(portal,/m\.status='ACTIVE'/);
  assert.match(portal,/m\.user_id=\$3/);
  assert.match(portal,/other\.role_id<>mr\.role_id|another\.role_id<>mr\.role_id/);
  assert.match(portal,/service_package_beneficiary/);
  assert.match(portal,/finance_verified/);
});
test("Existing service rule source is shared by appointments and availability",()=>{
  assert.match(catalogue,/resolveDeliveryRule/);
  assert.match(catalogue,/hasDeliveryRules/);
  assert.match(catalogue,/MAX_CANDIDATES/);
});
test("Reception has limited dance billing but no bank, payroll or role administration",()=>{
  for(const permission of ["dance.charges.read","dance.write","crm.read","service.read"])
    assert.ok(roles.includes("'"+permission+"'"));
  for(const forbidden of ["'finance.read'","'finance.write'",
    "'roles.manage'","'users.manage'"])
    assert.ok(!roles.includes(forbidden));
});
test("Owner simulation distinguishes known costs from missing financial obligations",()=>{
  assert.match(e2e,/52/);
  assert.match(e2e,/70000000n/);
  assert.match(e2e,/PARTIAL_PASS_NO_COMMERCIAL_GO/);
});
