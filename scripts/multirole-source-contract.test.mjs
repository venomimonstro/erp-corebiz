import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=(path)=>readFileSync(
  new URL("../"+path,import.meta.url),"utf8"
);
const roles=source("infrastructure/postgres/004_roles_permissions.sql");
const staff=source("infrastructure/postgres/125_service_staff_role.sql");
const roleService=source("apps/api/src/modules/platform/authorization/roles.service.ts");
const grants=source("apps/api/src/modules/platform/authorization/authorization.service.ts");
const permissionGuard=source("apps/api/src/modules/platform/authorization/permission.guard.ts");
const capabilityGuard=source("apps/api/src/modules/platform/authorization/capability.guard.ts");
const authGuard=source("apps/api/src/modules/platform/auth/auth.guard.ts");
const authService=source("apps/api/src/modules/platform/auth/auth.service.ts");
const rate=source("apps/api/src/modules/platform/auth/auth-rate-limit.service.ts");

const routes={
  owner:"apps/api/src/modules/business/dashboard/dashboard.controller.ts",
  catalog:"apps/api/src/modules/business/catalog/catalog.controller.ts",
  crm:"apps/api/src/modules/business/crm/crm.controller.ts",
  inventory:"apps/api/src/modules/business/inventory/inventory.controller.ts",
  finance:"apps/api/src/modules/business/finance/finance.controller.ts",
  service:"apps/api/src/modules/business/service-ops/booking.controller.ts",
  role:"apps/api/src/modules/platform/authorization/roles.controller.ts",
  goLive:"apps/api/src/modules/platform/go-live/go-live.controller.ts",
  team:"apps/api/src/modules/platform/tenants/tenants.controller.ts"
};
const pages={
  "OWNER":"/app","ADMIN":"/app/settings",
  "SALES_HEAD":"/app/crm/deals","SALES_MANAGER":"/app/crm/deals",
  "PROCUREMENT":"/app/purchases","WAREHOUSE":"/app/inventory/stock",
  "FINANCE":"/app/finance","SERVICE_STAFF":"/app/service/desk",
  "VIEWER":"/app"
};
const all=[
  "OWNER","ADMIN","SALES_HEAD","SALES_MANAGER","PROCUREMENT",
  "WAREHOUSE","FINANCE","SERVICE_STAFF","VIEWER"
];
test("All nine roles exist in SQL and support a distinct user journey",()=>{
  for(const code of all){
    assert.match(roles+staff,new RegExp("'"+code+"'"));
    assert.ok(pages[code]?.startsWith("/app"),code);
  }
  assert.match(roles,/DEFAULT 'all'/);
  assert.match(roles,/scope IN \('own', 'team', 'branch', 'all'\)/);
  assert.match(staff,/service\.read','own'/);
  assert.match(staff,/service\.write','own'/);
  assert.match(roles,/crm\.read','own'/);
  assert.match(roles,/finance\.write'/);
  assert.match(roles,/inventory\.write'/);
});

test("Permissions use per-tenant membership and ignore revoked identities",()=>{
  assert.match(grants,/tm\.user_id=\$4 AND tm\.status='ACTIVE'/);
  assert.match(grants,/rp\.permission_code IN \('\*',\$3\)/);
  assert.match(grants,/WHEN 'all' THEN 4/);
  assert.match(grants,/WHEN 'branch' THEN 3/);
  assert.match(grants,/WHEN 'team' THEN 2/);
  assert.match(grants,/WHEN 'own' THEN 1/);
  assert.match(grants,/if \(scope === "own"\) return \[context\.membershipId\]/);
  assert.match(permissionGuard,/this\.authorization\.hasPermission/);
  assert.match(permissionGuard,/throw new ForbiddenException/);
  assert.match(capabilityGuard,/capability_toggle/);
  assert.match(capabilityGuard,/result\.rows\[0\]\?\.enabled !== false/);
  assert.match(authGuard,/throw new UnauthorizedException/);
});

test("Role changes cannot mint OWNER or delegate broader authority",()=>{
  assert.match(roleService,/if\(isTargetOwner&&roleRow\.code!=="OWNER"\)/);
  assert.match(roleService,/roleRow\.code==="OWNER"&&\(!isTargetOwner\|\|!actor\.rows\[0\]\.is_owner\)/);
  assert.match(roleService,/target\.permission_code/);
  assert.match(roleService,/NOT EXISTS/);
  assert.match(roleService,/DELETE FROM membership_role/);
  assert.match(roleService,/INSERT INTO membership_role/);
  assert.match(roleService,/membership\.role_changed/);
});

test("Auth revokes sessions and enforces registration rate-limit",()=>{
  assert.match(authService,/corebiz_auth_switch_tenant/);
  assert.match(authService,/corebiz_auth_accept_invitation/);
  assert.match(rate,/count > 5/);
  assert.match(rate,/count > 10/);
  assert.match(rate,/ipCount > 100/);
});

test("Sensitive API routes have permission decorators",()=>{
  const anchors=[
    ["catalog",/RequirePermission\("catalog\.write"\)/],
    ["crm",/RequirePermission\("crm\.write"\)/],
    ["inventory",/RequirePermission\("inventory\.write"\)/],
    ["finance",/RequirePermission\("finance\.read"\)/],
    ["finance",/RequirePermission\("finance\.write"\)/],
    ["service",/RequirePermission\("service\.read"\)/],
    ["service",/RequirePermission\("service\.write"\)/],
    ["role",/RequirePermission\("roles\.manage"\)/],
    ["goLive",/RequirePermission\("go_live\.manage"\)/],
    ["team",/RequirePermission\("users\.manage"\)/],
    ["owner",/RequirePermission\("dashboard\.owner\.read"\)/]
  ];
  for(const [file,pattern] of anchors)
    assert.match(source(routes[file]),pattern,file+" missing guard");
});

test("Role E2E uses genuine permission switching without exceeding registration budget",()=>{
  const multi=source("scripts/multirole-api-e2e.mjs");
  assert.match(multi,/COREBIZ_CONFIRM_DISPOSABLE_DB/);
  assert.match(multi,/localhost/);
  assert.match(multi,/127\.0\.0\.1/);
  assert.equal((multi.match(/"\/auth\/register-invited"/g)||[]).length,1,
    "exactly one invitation helper, used for only two employees");
  assert.match(multi,/rolesToCycle/);
  assert.match(multi,/SALES_MANAGER/);
  assert.match(multi,/SALES_HEAD/);
  assert.match(multi,/SERVICE_STAFF/);
  assert.match(multi,/WAREHOUSE/);
  assert.match(multi,/FINANCE/);
  assert.match(multi,/ADMIN/);
  assert.match(multi,/VIEWER/);
  assert.match(multi,/Second company|second-tenant-isolation/);
  assert.match(multi,/logout-revocation/);
  assert.match(multi,/roleId:roleByCode\.get\("OWNER"\)\.id/);
  assert.match(multi,/result:"PASS",mode:"DISPOSABLE_MULTI_ROLE_API_E2E"/);
  assert.doesNotMatch(multi,/console\.log\(.*(?:cookie|oneTimeToken)/);
});

test("Service staff cannot view visit charges or finance accounts",()=>{
  const booking=source("apps/api/src/modules/business/service-ops/booking.service.ts");
  const existing=source("apps/api/src/modules/business/service-ops/booking-finance-privacy.spec.ts");
  assert.match(booking,/redactBookingFinancials/);
  assert.match(booking,/finance\.read/);
  assert.match(booking,/billing:null/);
  assert.match(booking,/refund:null/);
  assert.match(existing,/bookingDetails/);
  assert.match(existing,/bookings/);
});
