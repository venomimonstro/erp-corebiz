import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const code=(path)=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const stages=code("apps/web/lib/shared-business-stage-actions.ts");
const setup=code("apps/web/app/app/dance/setup/page.tsx");
const service=code("apps/api/src/modules/business/service-ops/booking.service.ts");
const resources=code("apps/api/src/modules/business/service-ops/resources.service.ts");
const servicesPage=code("apps/web/app/app/dance/services/page.tsx");
const staffPage=code("apps/web/app/app/dance/staff/page.tsx");
const receptionist=code("infrastructure/postgres/247_dance_studio_manager_role.sql");

test("Every owner stage has an action, owner and a non-destructive invariant",()=>{
  const ids=[...stages.matchAll(/\bid:"([a-z-]+)"/g)].map(x=>x[1]);
  assert.equal(ids.length,11);
  assert.equal(new Set(ids).size,ids.length);
  for(const id of ["organization","services","staff","rooms","directions",
    "calendar","clients","packages","finance","portal","go-live"])
    assert.ok(ids.includes(id),"stage missing "+id);
  assert.match(stages,/systemOfRecord/);
  assert.match(stages,/origin:"shared"\|"dance"/);
  assert.match(stages,/invariant:/);
  assert.doesNotMatch(stages,/label:"Удалить (навсегда|запись|платёж)/i);
  assert.match(setup,/danceBusinessStages\.map/);
  assert.match(setup,/\(entry\.code===code\|\|entry\.code==="\*"\)/);
  assert.match(setup,/нет прав/);
});

test("Service catalog edits are concurrency-safe across two branches",()=>{
  assert.match(service,/EXTRACT\(EPOCH FROM s\.updated_at\)::text AS revision/);
  assert.match(service,/EXTRACT\(EPOCH FROM updated_at\)::text AS revision/);
  assert.match(service,/current\.revision!==input\.expectedRevision/);
  assert.match(service,/FOR UPDATE/);
  assert.match(service,/service\.catalog_updated/);
  assert.match(servicesPage,/expectedRevision:chosen\.revision/);
  assert.match(servicesPage,/другой менеджер/i);
});

test("Shared employee resources also reject stale concurrent edits",()=>{
  assert.match(resources,/EXTRACT\(EPOCH FROM r\.updated_at\)::text AS revision/);
  assert.match(resources,/current\.rows\[0\]\.revision!==input\.expectedRevision/);
  assert.match(resources,/service\.resource_renamed/);
  assert.match(staffPage,/expectedRevision:current\.revision/);
  assert.match(resources,/service\.resource_archived/);
});

test("Reception can book and sell but cannot change tariffs or package prices",()=>{
  const managerRole=receptionist.slice(receptionist.indexOf("FROM (VALUES"),
    receptionist.indexOf("ON CONFLICT(role_id,permission_code)"));
  assert.match(managerRole,/'service\.write'/);
  assert.match(managerRole,/'dance\.write'/);
  assert.doesNotMatch(managerRole,/'catalog\.write'/);
  assert.doesNotMatch(managerRole,/'finance\.write'/);
  const segment=(begin,end)=>service.slice(service.indexOf(begin),service.indexOf(end,service.indexOf(begin)));
  for(const [a,b] of [
    ["  async createService(","  async updateService("],
    ["  async updateService(","  /** Remove a service"],
    ["  async createDeliveryRule(","  async archiveDeliveryRule("],
    ["  async archiveDeliveryRule(","  async technologyCards("],
    ["  async createPackagePlan(","  async packages("]
  ]){
    assert.match(segment(a,b),/resolveScope\(context,"catalog\.write"\)/,
      "price-creating endpoint missing governance "+a);
  }
  assert.match(service,/async issuePackage\(/);
  assert.match(stages,/Создать тариф абонемента[^\n]*catalog\.write/);
});
