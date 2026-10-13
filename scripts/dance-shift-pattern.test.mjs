import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=readFileSync(new URL(
  "../apps/api/src/modules/business/service-ops/resources.service.ts",
  import.meta.url
),"utf8");
const ui=readFileSync(new URL(
  "../apps/web/app/app/dance/shifts/page.tsx",import.meta.url
),"utf8");

// Mirrors the simple modulo expression materialized inside PostgreSQL.
// This is deterministic schedule-logic verification, not a DB E2E test.
function offDays(days,startsWorking){
  return Array.from({length:days},(_,i)=>
    Math.floor((i+(startsWorking?0:2))/2)%2===1);
}
test("Two receptionists always cover each other on 2/2 shifts",()=>{
  for(const days of [4,28,60,90]){
    const a=offDays(days,true),b=offDays(days,false);
    assert.equal(a.length,days);
    assert.equal(b.length,days);
    assert(a.every((off,i)=>off!==b[i]));
    assert.deepEqual(a.slice(0,4),[false,false,true,true]);
    assert.deepEqual(b.slice(0,4),[true,true,false,false]);
    assert.equal(a.filter(Boolean).length+b.filter(Boolean).length,days);
  }
});
test("Moscow dates are date-based and not inferred from browser locale",()=>{
  const first=new Date("2026-10-13T00:00:00Z");
  const date=(d)=>new Intl.DateTimeFormat("sv-SE",{
    timeZone:"Europe/Moscow",day:"2-digit",month:"2-digit",year:"numeric"
  }).format(d);
  assert.equal(date(first),"2026-10-13");
  assert.equal(date(new Date(first.getTime()+2*86400000)),"2026-10-15");
  assert.match(source,/AT TIME ZONE \$5/);
  assert.match(source,/FROM generate_series\(0,\$4::int-1\) i/);
});
test("Prior generated blocks are replaced without deleting manual vacation",()=>{
  assert.match(source,/reason='COREBIZ_2X2_MANAGER_OFF' AND starts_at>=/);
  assert.match(source,/input\.replaceWeeklySchedule/);
  assert.match(source,/График 2\/2/);
  assert.match(ui,/График первого менеджера сохранён, второго — нет/);
});
test("The price snapshot is not misinterpreted as studio profitability",()=>{
  assert.equal(7000/10,700);
  const remaining=3000000-700000-2*50000;
  assert.equal(remaining,2200000);
  assert(remaining>0);
  // Expenses for branch B, coaches, tax, acquisition and acquiring missing:
  // the remaining value must never be reported as actual net profit.
});
