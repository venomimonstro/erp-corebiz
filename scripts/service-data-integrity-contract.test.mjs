import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const file=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const booking=file("apps/api/src/modules/business/service-ops/booking.service.ts");
const portal=file("apps/api/src/modules/business/dance-studio/dance-customer-portal.service.ts");
const core=file("infrastructure/postgres/151_dance_studio_core.sql");
const packages=file("infrastructure/postgres/145_service_packages.sql");
const charge=file("infrastructure/postgres/152_dance_finance_allocations.sql");
const money=file("infrastructure/postgres/013_finance_lite.sql");
const publicUi=file("apps/web/app/portal/dance/page.tsx");
const testFile=file("scripts/dance-two-branch-owner-e2e.mjs");

test("service archiving uses real schema and preserves future bookings",()=>{
  const section=booking.split("async archiveService(")[1]?.split("async deliveryRules(")[0];
  assert.ok(section,"Owner service archival missing");
  assert.doesNotMatch(section,/dance_program[\s\S]*?service_id=\$2/);
  assert.match(section,/FROM service_booking/);
  assert.match(section,/ends_at>now\(\)/);
  assert.match(section,/status='ARCHIVED'/);
  assert.match(section,/users\.manage/);
  assert.match(core,/CREATE TABLE dance_program/);
  assert.doesNotMatch(core,/service_id uuid.*REFERENCES service_catalog_item/);
});

test("family visits, groups and programs use actual relational table keys",()=>{
  for(const table of [
    "dance_student","dance_group","dance_group_member",
    "dance_program","dance_lesson","dance_lesson_participant"
  ])assert.match(core,new RegExp("CREATE TABLE "+table+"\\\\s*\\\\("));
  assert.match(portal,/FROM dance_group_member gm/);
  assert.match(portal,/JOIN dance_group g/);
  assert.match(portal,/JOIN dance_program dp/);
  assert.match(portal,/FROM dance_lesson_participant lp/);
  assert.match(portal,/AND lp\.student_id=ANY\(\$2::uuid\[\]\)/);
  assert.match(portal,/a\.membership_id=\$2/);
  assert.match(portal,/m\.user_id=\$3/);
});

test("family subscription balance is not confused with received cash",()=>{
  for(const column of ["reserved_visits","used_visits","visit_limit_snapshot"])
    assert.match(packages,new RegExp(column+" "));
  assert.match(portal,/sp\.visit_limit_snapshot-sp\.reserved_visits-sp\.used_visits/);
  assert.match(portal,/FROM service_package_beneficiary b/);
  assert.match(portal,/sp\.party_id=ANY/);
  assert.match(portal,/sp\.tenant_id=\$1/);
  assert.match(portal,/CASE WHEN o\.id IS NULL THEN NULL/);
  assert.match(portal,/finance_verified/);
  assert.match(publicUi,/Платёж и задолженность требуют сверки в студии/);
  assert.match(money,/settled_minor bigint NOT NULL DEFAULT 0/);
  assert.match(charge,/obligation_id uuid REFERENCES financial_obligation/);
});

test("realistic studio tests never pass without an isolated database",()=>{
  assert.match(testFile,/COREBIZ_CONFIRM_DISPOSABLE_DB/);
  assert.match(testFile,/localhost/);
  assert.match(testFile,/127\.0\.0\.1/);
  assert.match(testFile,/52/);
  assert.match(testFile,/700000/);
  assert.match(testFile,/PARTIAL_PASS_NO_COMMERCIAL_GO/);
});

test("scheduling and reserves retain separate source-of-truth states",()=>{
  assert.match(booking,/async availability\(/);
  assert.match(booking,/resourceAvailable\(/);
  assert.match(booking,/async createBooking\(/);
  assert.match(booking,/idempotencyKey/);
  assert.match(booking,/pg_advisory_xact_lock/);
  assert.match(booking,/settlePackageRedemption/);
});
