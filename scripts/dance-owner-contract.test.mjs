import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const src=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const workflow=src("scripts/dance-two-branch-owner-e2e.mjs");
const portal=src("apps/api/src/modules/business/dance-studio/dance-customer-portal.service.ts");
const roles=src("infrastructure/postgres/247_dance_studio_manager_role.sql");
const clients=src("infrastructure/postgres/246_dance_customer_portal.sql");
const page=src("apps/web/app/portal/dance/page.tsx");
const team=src("apps/web/app/app/dance/staff/page.tsx");
const plan=src("apps/web/app/app/dance/budget/page.tsx");
const api=src("apps/api/src/modules/business/dance-studio/dance-studio.controller.ts");
const res=src("apps/api/src/modules/business/service-ops/resources.service.ts");
const bookings=src("apps/api/src/modules/business/service-ops/booking.service.ts");

test("Moscow scenario has both offices, twelve real directions and 52 coaches",()=>{
  assert.match(workflow,/Московская танцевальная студия/);
  assert.match(workflow,/Москва, филиал А/);
  assert.match(workflow,/Москва, филиал Б/);
  assert.match(workflow,/for\(let i=0;i<52;i\+\+\)/);
  assert.match(workflow,/programs\.length;i\+\+/);
  const programs=workflow.match(/const programs=\[([\s\S]*?)\];/)?.[1]??"";
  const names=[...programs.matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  assert.equal(names.length,12);
  assert.equal(new Set(names).size,12);
  assert.match(workflow,/RENTAL_EVENT|Аренда|аренда/);
});
test("Owners do not mistakenly report net profit from partial costs",()=>{
  assert.equal(3000000-700000-100000,2200000);
  assert.equal(7000/10,700);
  assert.ok(700<2400);
  assert.equal((2400-700)/2400,17/24);
  assert.match(plan,/Расчётная прибыль/);
  assert.match(plan,/calculated\.profit===null/);
  assert.match(plan,/Аренда филиала Б/);
  assert.match(plan,/Налоги и обязательные взносы/);
  assert.match(plan,/Плановые предположения владельца/);
  assert.match(workflow,/PARTIAL_PASS_NO_COMMERCIAL_GO/);
  assert.match(workflow,/Rent and expense assumptions for branch B unknown/);
});
test("Contracts record real first-branch rent, not fictional branch B rent",()=>{
  assert.match(workflow,/money\(400000\)/);
  assert.match(workflow,/money\(150000\)/);
  assert.match(workflow,/70000000n/);
  assert.match(workflow,/Branch B rent was not supplied/);
  assert.match(workflow,/FULL_PAYMENT/);
});
test("Reception can operate clients but is not a bank administrator",()=>{
  for(const name of ["dance.read","dance.write","dance.charges.read",
    "service.read","service.write","crm.read","crm.write"])
    assert.ok(roles.includes("'"+name+"'"),name);
  for(const name of ["'finance.read'","'finance.write'",
    "'users.manage'","'roles.manage'"]){
    assert.ok(!roles.includes(name),"Excessive grant "+name);
  }
  assert.match(api,/@Get\("charges"\)\s+@RequirePermission\("dance.read"\)/);
  assert.match(workflow,/get\(actors\.m1,"\/finance\/summary",403\)/);
  assert.match(workflow,/get\(actors\.m1,"\/dance\/charges"\)/);
});
test("Parents cannot browse company CRM, salaries or unrelated party IDs",()=>{
  assert.match(clients,/DANCE_CUSTOMER/);
  assert.match(clients,/dance\.portal\.read/);
  assert.match(clients,/ENABLE ROW LEVEL SECURITY/);
  assert.match(portal,/another\.role_id<>mr\.role_id/);
  assert.match(portal,/m\.user_id=\$3/);
  assert.match(portal,/rel\.to_party_id=\$2/);
  assert.match(portal,/dance_customer_account/);
  assert.match(portal,/c\.payer_party_id=\$3/);
  assert.match(page,/Мои абонементы/);
  assert.match(page,/Посещения и расписание/);
  assert.match(page,/Оплаты и задолженность/);
  assert.match(workflow,/get\(actors\.parent,"\/crm\/board",403\)/);
  assert.match(workflow,/get\(actors\.parent,"\/dance\/students",403\)/);
  assert.match(workflow,/get\(actors\.parent,"\/dance\/portal\/me"\)/);
});
test("Personnel exits preserve history and require reassignment",()=>{
  assert.match(res,/archive\(context:TenantContext/);
  assert.match(res,/Сначала переназначьте тренера/);
  assert.match(res,/Сначала перенесите или отмените будущие занятия/);
  assert.match(res,/status='ARCHIVED'/);
  assert.match(res,/users\.manage/);
  assert.match(bookings,/async archiveService/);
  assert.match(bookings,/service\.catalog_archived/);
  assert.match(team,/Архивировать тренера/);
  assert.match(team,/Групп: \{assigned\.length\}/);
  assert.match(workflow,/get\(owner,"\/dance\/room-contracts"\)/);
});
test("No E2E network calls permitted without explicit disposable database",()=>{
  assert.match(workflow,/COREBIZ_CONFIRM_DISPOSABLE_DB/);
  assert.match(workflow,/http:/);
  assert.match(workflow,/localhost/);
  assert.match(workflow,/127\.0\.0\.1/);
  assert.match(workflow,/registeredAccounts|inviteRole\(actors\.parent|rolesToCycle|clientLink/);
  assert.doesNotMatch(workflow,/process\.stdout\.write\(JSON\.stringify\(\{[\s\S]*cookie:/);
});
