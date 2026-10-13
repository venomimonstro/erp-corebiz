import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const fromRepo=path=>readFileSync(
  new URL("../"+path,import.meta.url),"utf8"
);
const catalog=JSON.parse(fromRepo("apps/web/lib/dance-setup-recovery.json"));
const doctor=fromRepo("apps/api/src/modules/business/dance-studio/dance-studio.service.ts");
const controller=fromRepo("apps/api/src/modules/business/dance-studio/dance-studio.controller.ts");
const page=fromRepo("apps/web/app/app/dance/diagnostics/page.tsx");
const firstDay=fromRepo("apps/web/app/app/dance/setup/page.tsx");
const simulator=fromRepo("scripts/dance-two-branch-owner-e2e.mjs");
const nav=fromRepo("apps/web/components/dance-workspace-nav.tsx");

test("30 owner pain points have an actionable fix and real route",()=>{
  assert.equal(catalog.length,30);
  const ids=new Set();
  for(const item of catalog){
    assert.equal(ids.has(item.id),false,"duplicate scenario "+item.id);
    ids.add(item.id);
    for(const field of ["id","title","cause","recovery","href"])
      assert.ok(typeof item[field]==="string"&&item[field].length>=4,
        item.id+" missing "+field);
    assert.match(item.href,/^\/(app\/|login$)/);
    assert.ok(item.recovery.length>=35,item.id+" fix is not actionable");
  }
  for(const scenario of ["coach","role","rule","overlap","parent",
    "portal","package","debt","payment","shift","dismissal","timeout"]){
    assert.ok(ids.has(scenario),scenario+" lost recovery steps");
  }
});

test("Every structural studio blocker has count, page and recovery",()=>{
  assert.match(doctor,/async setupDoctor\(/);
  assert.match(doctor,/WHERE tenant_id=\$1/);
  for(const id of ["branches","trainers","directions","rooms","group",
    "missing_resources","delivery_rules","lessons","plans","managers",
    "rent","payroll","clients","portal","reconcile"]){
    assert.match(doctor,new RegExp('id:"'+id+'"'));
  }
  assert.match(doctor,/commercialReady:false/);
  assert.match(doctor,/operationalSetupComplete:blockers\.length===0/);
  assert.match(doctor,/nextAction:\(blockers\[0\]\?\?warnings\[0\]\?\?null\)/);
  assert.match(controller,/@Get\("setup-doctor"\)/);
  assert.match(controller,/@RequirePermission\("dance\.read"\)/);
});

test("Owner can diagnose while remote API is down, never stale-green",()=>{
  assert.match(page,/setDiagnostic\(null\)/);
  assert.match(page,/commercialReady:false/);
  assert.match(page,/recoveryCases\.filter/);
  assert.match(page,/Повторить проверку/);
  assert.match(page,/зеленые статусы сброшены|зелёные статусы сброшены/);
  assert.match(nav,/\/app\/dance\/diagnostics/);
  assert.match(firstDay,/setData\(null\)/);
  assert.match(firstDay,/Первые настройки/);
  assert.match(firstDay,/\/app\/dance\/diagnostics/);
});

test("Disposable API checks actual 400/403/409 and refuses fake GO",()=>{
  assert.match(simulator,/COREBIZ_CONFIRM_DISPOSABLE_DB/);
  assert.match(simulator,/setup-doctor\?scenario=unknown",400/);
  assert.match(simulator,/actors\.parent,"\/dance\/setup-doctor\?scenario=two_branch_52",403/);
  assert.match(simulator,/commercialReady,false/);
  assert.match(simulator,/actors\.m1,"\/service\/resources\/"\+trainers\[2\].id\+"\/archive"/);
  assert.match(simulator,/groupServices\[0\].id\+"\/archive"/);
  assert.match(simulator,/finance\/summary",403/);
});

test("Negative rehearsals are design-level, not fake business transactions",()=>{
  let caseCount=0;
  const results=[];
  for(const problem of catalog){
    // A deterministic rehearsal validates available recovery information,
    // not an actual DB transaction or live payment.
    assert.ok(problem.cause!==problem.recovery);
    results.push({symptom:problem.id,issue:"BLOCKED",
      instructionsAvailable:Boolean(problem.href&&problem.recovery)});
    caseCount++;
  }
  assert.equal(caseCount,30);
  assert.equal(results.filter(x=>!x.instructionsAvailable).length,0);
  console.log(JSON.stringify({
    mode:"OFFLINE_RECOVERY_PLAYBOOK_ONLY",
    designCases:caseCount,networkRequests:0,
    commercialReady:false
  }));
});
