import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const guides=JSON.parse(readFileSync(
  new URL("../apps/web/lib/owner-industry-playbooks.json",import.meta.url),"utf8"
));
const templates=readFileSync(
  new URL("../apps/api/src/modules/platform/customization/business-verticals.ts",import.meta.url),"utf8"
);
const sidebar=readFileSync(
  new URL("../apps/web/components/app-sidebar.tsx",import.meta.url),"utf8"
);
const onboarding=readFileSync(
  new URL("../apps/web/app/app/start/page.tsx",import.meta.url),"utf8"
);

const verticals=[...templates.matchAll(/^  ([A-Z][A-Z0-9_]+): \{$/gm)]
  .map(row=>row[1]).sort();
const availableRoutes=new Set(
  [...sidebar.matchAll(/\["(\/app(?:\/[^"]+)?)",\s*"[^"]+",\s*"[^"]+"\]/g)]
    .map(x=>x[1])
);
// /app/settings is the settings homepage; /app itself also exists.
availableRoutes.add("/app/settings");
availableRoutes.add("/app");

function validateCatalog(candidate){
  assert.equal(candidate.schemaVersion,1);
  const supplied=Object.keys(candidate.verticals).sort();
  assert.deepEqual(supplied,verticals,"All business verticals must be covered");
  assert.ok(candidate.common.length>=8,"The SaaS lifecycle is not optional");
  for(const [code,steps] of Object.entries(candidate.verticals)){
    assert.ok(steps.length>=5,code+" must cover more than first sale");
    const combined=[...candidate.common,...steps];
    for(let index=0;index<combined.length;index++){
      const row=combined[index];
      assert.ok(availableRoutes.has(row.route),
        code+" screen "+index+" links to unknown "+row.route);
      for(const field of ["title","expected","blocked","fix"])
        assert.ok(typeof row[field]==="string"&&row[field].trim().length>=3,
          code+" step "+index+" missing "+field);
      assert.ok(Array.isArray(row.fields)&&row.fields.length>=2,
        code+" step "+index+" missing owner input fields");
      assert.ok(row.fields.every(x=>typeof x==="string"&&x.trim().length>=2));
    }
  }
  return candidate;
}

/** In-memory contract rehearsal, NEVER an actual deployed business event.
 * For each failure injection, the simulated owner recovers before moving on.
 */
function simulateOwner(code,failAt){
  const steps=[...guides.common,...guides.verticals[code]];
  const log=[];
  let completed=0;
  for(let i=0;i<steps.length;i++){
    const step=steps[i];
    const attempt={
      vertical:code,screen:step.route,index:i,
      fields:step.fields,result:"OK"
    };
    if(i===failAt){
      attempt.result="BLOCKED";
      log.push(attempt);
      assert.ok(step.blocked.length>2&&step.fix.length>2);
      log.push({
        vertical:code,screen:step.route,index:i,
        result:"RECOVERED",resolution:step.fix
      });
    }else log.push(attempt);
    completed++;
  }
  assert.equal(completed,steps.length);
  return {vertical:code,screens:completed,failureInjected:failAt,trace:log};
}

test("Every configured business has complete, routable setup and recovery",()=>{
  validateCatalog(guides);
  assert.match(onboarding,/owner-industry-playbooks\.json/);
  assert.match(onboarding,/entry\.blocked/);
  assert.match(onboarding,/entry\.fix/);
  assert.match(onboarding,/Проверить вручную/);
});

test("Design-level owner simulation: success and every blocked setup step",()=>{
  let journeys=0,screenTraversals=0,failures=0;
  for(const code of verticals){
    const length=guides.common.length+guides.verticals[code].length;
    for(let failureIndex=-1;failureIndex<length;failureIndex++){
      const simulated=simulateOwner(code,failureIndex);
      assert.equal(simulated.screens,length);
      const recovered=simulated.trace.filter(x=>x.result==="RECOVERED");
      assert.equal(recovered.length,failureIndex<0?0:1);
      journeys++;
      screenTraversals+=length;
      if(failureIndex>=0)failures++;
    }
  }
  console.log(JSON.stringify({
    kind:"OFFLINE_DESIGN_SIMULATION_ONLY",verticals:verticals.length,
    universalScreens:guides.common.length,
    industryScreens:Object.values(guides.verticals).reduce((n,rows)=>n+rows.length,0),
    simulatedJourneys:journeys,screenTraversals,failuresInjected:failures,
    runtimeApiRequests:0,productionGoApproved:false
  }));
});

test("Incomplete playbooks never count as a working vertical",()=>{
  const broken=structuredClone(guides);
  broken.verticals.BEAUTY_SALON[0].fix="";
  assert.throws(()=>validateCatalog(broken));
  const missing=structuredClone(guides);
  delete missing.verticals.WAREHOUSE_3PL;
  assert.throws(()=>validateCatalog(missing));
  const wrongRoute=structuredClone(guides);
  wrongRoute.verticals.RETAIL_STORE[0].route="/app/nonexistent";
  assert.throws(()=>validateCatalog(wrongRoute));
});
