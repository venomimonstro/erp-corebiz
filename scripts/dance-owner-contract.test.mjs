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
  assert.match(plan,/Предварительная прибыль/);
  assert.match(plan,/calculated\.profit===null/);
  assert.match(plan,/Аренда залов филиала Б/);
  assert.match(plan,/Налоги и страховые взносы/);
  assert.match(plan,/Плановые значения/);
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

test("Client invitations work with the real hash-token acceptor and safe redirects",()=>{
  const invite=src("apps/web/app/invite/page.tsx");
  const login=src("apps/web/app/login/page.tsx");
  const owner=src("apps/web/app/app/dance/clients/page.tsx");
  assert.match(invite,/window\.location\.hash/);
  assert.match(owner,/\/invite#token=/);
  assert.match(invite,/context\.roles\.includes\("DANCE_CUSTOMER"\)/);
  assert.match(login,/requested==="\/portal\/dance"/);
  assert.match(login,/context\.roles\.includes\("DANCE_CUSTOMER"\)/);
});

test("Month plans persist per tenant and never silently fill example figures",()=>{
  const sql=src("infrastructure/postgres/248_dance_owner_budget_plan.sql");
  const logic=src("apps/api/src/modules/business/dance-studio/dance-budget.service.ts");
  assert.match(sql,/PRIMARY KEY\(tenant_id,month_start\)/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
  assert.match(sql,/rent_branch_b_minor bigint/);
  assert.match(logic,/expectedVersion/);
  assert.match(logic,/WHERE dance_budget_plan\.version=\$12/);
  assert.match(logic,/finance\.read/);
  assert.match(logic,/finance\.write/);
  assert.match(plan,/const empty=/);
  assert.match(plan,/setInputs\(sample\(\)\)/);
  assert.match(plan,/\/dance\/budget\?month=/);
  assert.match(plan,/method:"PATCH"/);
  assert.match(plan,/rubles\(v\)===null/);
});

test("Leased small halls are not sold twice at full room capacity",()=>{
  assert.match(workflow,/DISPOSABLE/);
  assert.match(workflow,/rentServices/);
  assert.match(workflow,/deliveryFormat:"RENTAL"/);
  assert.match(workflow,/priceMinor:money\(1200\)/);
  assert.match(workflow,/resources:\[\{resourceId:rental.resourceId,capacityUnits:8\}\]/);
  assert.match(workflow,/idempotencyKey:"dance-rental-conflict-"/);
  assert.match(workflow,/\},409\);/);
});
test("Trainer exit suspends tenant membership while preserving history",()=>{
  const tenantService=src("apps/api/src/modules/platform/tenants/tenants.service.ts");
  const tenantController=src("apps/api/src/modules/platform/tenants/tenants.controller.ts");
  const authDb=src("infrastructure/postgres/119_auth_rls_bootstrap.sql");
  assert.match(tenantService,/async setStaffStatus/);
  assert.match(tenantService,/if\(member\.is_owner\)/);
  assert.match(tenantService,/context\.membershipId===membershipId/);
  assert.match(tenantService,/membership\.suspended/);
  assert.match(tenantService,/membership\.reactivated/);
  assert.match(tenantController,/@Post\("team\/:membershipId\/suspend"\)/);
  assert.match(tenantController,/@Post\("team\/:membershipId\/reactivate"\)/);
  assert.match(authDb,/m\.status = 'ACTIVE'/);
  assert.match(team,/Приостановить вход/);
  assert.match(team,/Восстановить вход/);
});


test("Moscow 2-on/2-off manager rota uses one shared resource calendar",()=>{
  const source=src("apps/api/src/modules/business/service-ops/resources.service.ts");
  const controller=src("apps/api/src/modules/business/service-ops/resources.controller.ts");
  const screen=src("apps/web/app/app/dance/shifts/page.tsx");
  const nav=src("apps/web/components/dance-workspace-nav.tsx");
  assert.match(source,/async twoByTwo\(/);
  assert.match(source,/COREBIZ_2X2_MANAGER_OFF/);
  assert.match(source,/AT TIME ZONE \$5/);
  assert.match(source,/reason='COREBIZ_2X2_MANAGER_OFF' AND starts_at>=/);
  assert.match(source,/input\.replaceWeeklySchedule/);
  assert.match(source,/users\.manage/);
  assert.match(source,/input\.days>90/);
  assert.match(controller,/@Post\(":id\/two-by-two"\)/);
  assert.match(screen,/График первого менеджера сохранён, второго — нет/);
  assert.match(screen,/onClick=\{\(\)=>void apply\(\)\}/);
  assert.match(screen,/Дней вперёд \(4–90\)/);
  assert.match(nav,/\/app\/dance\/shifts/);
  assert.match(workflow,/\/two-by-two/);
  assert.match(workflow,/calendar\.blockedDays,30/);
  assert.match(workflow,/calendar\.days,60/);
  const booking=src("apps/api/src/modules/business/service-ops/booking.service.ts");
  assert.match(booking,/FROM service_resource_block rb/);
  assert.match(booking,/Number\(row\.blocked\)\+capacityUnits>row\.capacity/);

});
test("Shift rosters have negative tests for management authorization and manual overrides",()=>{
  const suite=src("apps/api/src/modules/business/service-ops/resources-two-by-two.spec.ts");
  assert.match(suite,/refuses to silently destroy/);
  assert.match(suite,/requires both schedule rights/);
  assert.match(suite,/vacation blocks untouched/);
  assert.match(suite,/does not let a manager assign/);
});


test("A trainer gets private own-only calendar, never the company's clients or cashflow",()=>{
  const trainerRole=src("infrastructure/postgres/250_dance_trainer_portal.sql");
  const service=src("apps/api/src/modules/business/dance-studio/dance-trainer-portal.service.ts");
  const screen=src("apps/web/app/portal/trainer/page.tsx");
  const staff=src("apps/web/app/app/dance/staff/page.tsx");
  const login=src("apps/web/app/login/page.tsx");
  const invite=src("apps/web/app/invite/page.tsx");
  const api=src("apps/api/src/modules/business/dance-studio/dance-studio.controller.ts");
  assert.match(trainerRole,/DANCE_TRAINER/);
  assert.match(trainerRole,/dance\.trainer\.read','own'/);
  assert.doesNotMatch(trainerRole,/finance\.read/);
  assert.match(service,/l\.trainer_resource_id=\$2/);
  assert.match(service,/r\.membership_id=\$2/);
  assert.match(service,/m\.user_id=\$3/);
  assert.match(service,/Период|Интервал календаря/);
  assert.match(service,/other\.id<>s\.id/);
  assert.match(api,/@Get\("trainer\/me"\)/);
  assert.match(api,/@RequirePermission\("dance\.trainer\.read"\)/);
  assert.match(screen,/Моё расписание/);
  assert.match(screen,/Часов нагрузки/);
  assert.match(staff,/\/dance\/trainer\/link/);
  assert.match(login,/\/portal\/trainer/);
  assert.match(invite,/\/portal\/trainer/);
  assert.match(workflow,/get\(actors\.m2,"\/dance\/trainer\/me\?from="/);
  assert.match(workflow,/get\(actors\.m2,"\/dance\/charges",403\)/);
});

test("Tenant RLS portal links also enforce same-tenant foreign keys",()=>{
  const ddl=src("infrastructure/postgres/249_dance_portal_tenant_guard.sql");
  assert.match(ddl,/CREATE TRIGGER dance_customer_account_tenant_refs_v1/);
  assert.match(ddl,/corebiz_guard_tenant_references/);
  assert.match(ddl,/'membership_id','tenant_membership'/);
  assert.match(ddl,/'party_id','party'/);
  assert.match(ddl,/'linked_by_membership_id','tenant_membership'/);
});
test("Moscow family trial denies unrelated children and checks immediate revocation",()=>{
  assert.match(workflow,/secondFamilyView\.students/);
  assert.match(workflow,/post\(actors\.m1,"\/dance\/portal\/accounts\//);
  assert.match(workflow,/get\(actors\.parent,"\/dance\/portal\/me",403\)/);
  assert.match(portal,/dance\.portal_revoked/);
  assert.match(api,/@Post\("portal\/accounts\/:membershipId\/revoke"\)/);
});

test("Customer portal is revocable and never invents settled balances",()=>{
  const customerPage=src("apps/web/app/portal/dance/page.tsx");
  const portalSource=src("apps/api/src/modules/business/dance-studio/dance-customer-portal.service.ts");
  const unit=src("apps/api/src/modules/business/dance-studio/dance-customer-portal.spec.ts");
  assert.match(workflow,/stage="09b revoke and recover parent portal access"/);
  assert.match(workflow,/revoked\.revoked,true/);
  assert.match(workflow,/get\(actors\.parent,"\/dance\/portal\/me",403\)/);
  assert.match(workflow,/recovered\.students\.some/);
  assert.match(portalSource,/async revoke\(context:TenantContext/);
  assert.match(portalSource,/status='REVOKED'/);
  assert.match(portalSource,/dance\.portal_revoked/);
  assert.match(portalSource,/sp\.status='ACTIVE'/);
  assert.match(portalSource,/o\.id IS NULL THEN NULL/);
  assert.match(customerPage,/finance_verified/);
  assert.match(customerPage,/Ожидает подтверждения оплаты/);
  assert.match(customerPage,/Подтверждённая задолженность/);
  assert.match(unit,/restricts the account directory/);
  assert.match(unit,/revokes portal access transactionally/);
});
