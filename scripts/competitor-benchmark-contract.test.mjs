import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const repoFile=(path)=>readFileSync(
  new URL("../"+path,import.meta.url),"utf8"
);
const inv=repoFile("apps/api/src/modules/business/inventory/inventory.service.ts");
const planner=repoFile("apps/api/src/modules/business/inventory/replenishment-planner.ts");
const inventoryUi=repoFile("apps/web/app/app/inventory/replenishment/page.tsx");
const resource=repoFile("apps/api/src/modules/business/service-ops/resources.service.ts");
const booking=repoFile("apps/api/src/modules/business/service-ops/booking.service.ts");
const publicForms=repoFile("apps/api/src/modules/business/sites/site-forms.service.ts");
const sql=repoFile("infrastructure/postgres/248_service_public_online_policy.sql");
const publicUi=repoFile("apps/web/app/app/dance/staff/page.tsx");

test("Procurement recommendations separate physical shortage from inbound stock",()=>{
  assert.match(inv,/purchase_order_line pl/);
  assert.match(inv,/po.status IN \('CONFIRMED','PARTIALLY_RECEIVED'\)/);
  assert.match(inv,/pl\.ordered_quantity_milli-\s*pl\.received_quantity_milli/);
  assert.match(inv,/HAVING count\(\*\)=1/);
  assert.match(inv,/planReplenishment/);
  assert.match(planner,/BigInt\(input.physicalMilli\)/);
  assert.match(planner,/BigInt\(input.confirmedInboundMilli\)/);
  assert.match(planner,/toBuy=shortage>inbound/);
  assert.match(inventoryUi,/Дополнительно заказать/);
  assert.match(inventoryUi,/Подтверждено к поступлению/);
  assert.match(inventoryUi,/не увеличивает фактические остатки/);
});
test("Online specialist toggle stays independent of manual diary",()=>{
  assert.match(sql,/online_booking_enabled boolean NOT NULL DEFAULT true/);
  assert.match(sql,/online_min_lead_minutes integer/);
  assert.match(resource,/async updateOnlinePolicy\(/);
  assert.match(resource,/users.manage/);
  assert.match(booking,/if\(input.source==="PUBLIC_SITE"\)/);
  assert.match(booking,/!x.online_booking_enabled/);
  assert.match(booking,/startsAt.getTime\(\)<Date.now\(\)\+minLead/);
  assert.match(publicForms,/eligible=allowed.filter\(id=>online.has\(id\)\)/);
  assert.match(publicForms,/online.get\(slot.resourceId\)/);
  assert.match(publicUi,/Доступен клиентам онлайн/);
  assert.match(publicUi,/Сохранить настройки записи/);
});
test("No accidental purchase order or payment is created from a recommendation",()=>{
  const slice=inv.slice(inv.indexOf("async replenishment("),
    inv.indexOf("async adjust(",inv.indexOf("async replenishment(")));
  assert.doesNotMatch(slice,/INSERT INTO purchase_order/);
  assert.doesNotMatch(slice,/INSERT INTO inventory_movement/);
  assert.match(inventoryUi,/не создаётся автоматически/);
});
test("Offline form still does not see a disabled public specialist",()=>{
  const publicSection=publicForms.slice(
    publicForms.indexOf("async bookingAvailability("),
    publicForms.indexOf("async submit(",publicForms.indexOf("async bookingAvailability("))
  );
  assert.match(publicSection,/online_booking_enabled=true/);
  assert.match(publicSection,/status='ACTIVE'/);
  const internal=booking.slice(
    booking.indexOf("async availability("),booking.indexOf("async createBooking(")
  );
  // Internal calendar does not carry PUBLIC_SITE flags or visibility filters.
  assert.doesNotMatch(internal,/online_booking_enabled/);
});
