#!/usr/bin/env node
/**
 * Disposable API regression for ALL product verticals.
 * It creates one synthetic tenant, applies every niche, compares capabilities
 * with its template, and proves unrelated existing CRM data survives switches.
 * This deliberately does not exercise payments, fiscalization, shipments.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";

assert.equal(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB,"YES",
  "BLOCKED: explicit disposable PostgreSQL confirmation required");
const raw=process.env.COREBIZ_SMOKE_BASE_URL;
assert.ok(raw,"Set COREBIZ_SMOKE_BASE_URL to localhost disposable API");
const base=new URL(raw);
assert.equal(base.protocol,"http:");
assert.ok(["localhost","127.0.0.1","[::1]"].includes(base.hostname));
assert.equal(base.username,"");assert.equal(base.password,"");
const origin=process.env.COREBIZ_SMOKE_WEB_ORIGIN??"http://localhost:3000";
const guides=JSON.parse(readFileSync(
  new URL("../apps/web/lib/owner-industry-playbooks.json",import.meta.url),"utf8"
));
const oneTime=randomUUID();
const email="owner-all-industries-"+oneTime+"@example.invalid";
const password="Owner-Industry-"+oneTime;
let cookie="";
const steps=[];
async function request(method,path,body,allowed=[method==="POST"?201:200]){
  const result=await fetch(new URL("/api/v1"+path,base),{
    method,redirect:"error",signal:AbortSignal.timeout(20000),
    headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),
      ...(body===undefined?{}:{"Content-Type":"application/json"})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const session=result.headers.get("set-cookie");
  if(session?.startsWith("corebiz_session="))cookie=session.split(";")[0];
  assert.ok(allowed.includes(result.status),
    method+" "+path+" expected "+allowed.join("/")+
    " got HTTP "+result.status);
  const data=await result.json();
  assert.equal(data.ok,result.status>=200&&result.status<300,
    path+" response envelope");
  return data.data;
}
try{
  const options=await request("GET","/customization/business-verticals",undefined,[401]);
  // Expected to be unauthorized before account creation.
}catch(error){
  process.stderr.write("Pre-auth probe failed: "+
    (error instanceof Error?error.message:"unknown")+"\n");
  process.exit(1);
}
try{
  const account=await request("POST","/auth/register",{
    email,password,companyName:"Industry E2E "+oneTime.slice(0,8)
  });
  assert.ok(account.auth?.tenantId);
  const templates=await request("GET","/customization/business-verticals");
  const byCode=new Map(templates.map(t=>[t.code,t]));
  assert.deepEqual([...byCode.keys()].sort(),
    Object.keys(guides.verticals).sort());
  const customer=await request("POST","/crm/customers",{
    type:"PERSON",displayName:"Persistent test customer "+oneTime.slice(0,6)
  });
  assert.ok(customer.id);
  for(const code of Object.keys(guides.verticals)){
    const chosen=byCode.get(code);
    assert.ok(chosen,"Unknown code "+code);
    const changed=await request("PUT","/customization/business-vertical",{
      verticalCode:code
    });
    assert.equal(changed.verticalCode,code);
    assert.equal(changed.profileCode,chosen.profileCode);
    const profile=await request("GET","/customization/business-profile");
    assert.equal(profile.verticalCode,code);
    assert.equal(profile.profileCode,chosen.profileCode);
    const enabled=new Set(profile.capabilities
      .filter(x=>x.enabled).map(x=>x.key));
    for(const requirement of chosen.enabledCapabilities)
      assert.ok(enabled.has(requirement),
        code+": missing capability "+requirement);
    const activated=await request("GET","/dashboard/activation");
    assert.equal(activated.verticalCode,code);
    assert.ok(Array.isArray(activated.milestones));
    const clients=await request("GET","/crm/customers");
    assert.ok(clients.some(x=>x.id===customer.id),
      code+": switching vertical deleted/shared CRM data");
    steps.push({vertical:code,profile:chosen.profileCode,
      operationalMilestones:activated.milestones.length,
      requiredCapabilities:chosen.enabledCapabilities.length});
  }
  await request("PUT","/customization/business-vertical",{
    verticalCode:"NON_EXISTENT_VERTICAL"
  },[400]);
  await request("PUT","/customization/business-vertical",{
    verticalCode:"GENERAL"
  });
  const restored=await request("GET","/crm/customers");
  assert.ok(restored.some(x=>x.id===customer.id));
  process.stdout.write(JSON.stringify({
    result:"PASS",mode:"DISPOSABLE_API_E2E",verticals:steps.length,
    preservedCRM:true,unknownVerticalRejected:true,checks:steps,
    warnings:[
      "No user payment/fiscal/carrier provider tested",
      "Does not establish production readiness"
    ]
  },null,2)+"\n");
}catch(error){
  process.stderr.write("OWNER_ALL_VERTICALS_FAIL last="+
    (steps.at(-1)?.vertical??"registration")+" cause="+
    (error instanceof Error?error.message:"unknown").slice(0,220)+"\n");
  process.exitCode=1;
}
