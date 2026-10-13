#!/usr/bin/env node
/**
 * Multi-role disposable API journey. NEVER use on production.
 * Creates ONE owner and TWO invited users, cycles actual DB roles via
 * /roles/assign, then proves new privileges and prior revocation against
 * real HTTP sessions. Three registrations stay within the five/hour/IP
 * registration guard; do not disable or spoof security rate limiting.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

assert.equal(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB,"YES",
  "BLOCKED: disposable PostgreSQL environment must be explicitly confirmed");
const input=process.env.COREBIZ_SMOKE_BASE_URL;
assert.ok(input,"COREBIZ_SMOKE_BASE_URL required");
const base=new URL(input);
assert.equal(base.protocol,"http:","Local disposable API only");
assert.ok(["127.0.0.1","localhost","[::1]"].includes(base.hostname),
  "BLOCKED: only loopback APIs permitted");
assert.equal(base.username,"");
assert.equal(base.password,"");
assert.equal(base.search,"");
assert.equal(base.hash,"");
const origin=process.env.COREBIZ_SMOKE_WEB_ORIGIN??"http://localhost:3000";
const run=randomUUID();
const owner={label:"OWNER",cookie:""};
const employee={label:"STAFF",cookie:""};
const colleague={label:"COLLEAGUE",cookie:""};
const audit=[];
let phase="startup";
let role="OWNER";
const observed=new Set();
const status=(method)=>method==="POST"?201:200;
async function api(actor,method,path,body,expected=status(method)){
  const url=new URL("/api/v1"+path,base);
  const started=performance.now();
  const response=await fetch(url,{
    method,redirect:"error",signal:AbortSignal.timeout(20000),
    headers:{
      Origin:origin,
      ...(actor.cookie?{Cookie:actor.cookie}:{}),
      ...(body===undefined?{}:{"Content-Type":"application/json"})
    },
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const setCookie=response.headers.get("set-cookie");
  if(setCookie?.startsWith("corebiz_session="))
    actor.cookie=setCookie.split(";")[0];
  const accepted=Array.isArray(expected)?expected:[expected];
  const pathLabel=method+" "+url.pathname;
  if(!accepted.includes(response.status)){
    // Never log session tokens, passwords, invite links, response bodies.
    throw new Error(
      phase+"/"+role+"/"+actor.label+": "+pathLabel+
      " returned "+response.status+" expected "+accepted.join("/")
    );
  }
  const payload=await response.json();
  assert.equal(payload.ok,response.status>=200&&response.status<300,
    phase+": inconsistent JSON success envelope");
  audit.push({phase,role,actor:actor.label,method,
    endpoint:url.pathname.replace("/api/v1",""),
    status:response.status,durationMs:Math.round(performance.now()-started)});
  return payload.data;
}
const read=(actor,path,expected=200)=>api(actor,"GET",path,undefined,expected);
const write=(actor,path,body,expected=201)=>api(actor,"POST",path,body,expected);
const modify=(actor,path,body,expected=200)=>api(actor,"PUT",path,body,expected);
function phaseIs(name){phase=name;}
function hasPermission(context,code){
  const p=context.permissions.find(x=>x.code===code);
  const wildcard=context.permissions.find(x=>x.code==="*");
  return p?.scope??wildcard?.scope??null;
}
async function verifyRole(code,roleId,membershipId){
  phaseIs("role-"+code);
  role=code;
  await modify(owner,"/roles/assign",{membershipId,roleId});
  const context=await read(employee,"/workspace/context");
  assert.equal(context.roles.includes(code),true,
    "Live employee session must reflect "+code+" immediately");
  assert.equal(context.roles.length,1,"Role replacement must not retain old grants");
  assert.ok(context.tenantId);
  observed.add(code);
  return context;
}
async function permissionGate(context,permission,path){
  const expected=hasPermission(context,permission)?200:403;
  return read(employee,path,expected);
}
async function mustDeny(actor,method,path,payload){
  return api(actor,method,path,payload,[401,403]);
}
async function main(){
  phaseIs("preflight");
  const ready=await read(owner,"/health/ready");
  assert.equal(ready.status,"ok");
  await read(owner,"/auth/me",401);
  await read(owner,"/finance/summary",401);
  await read(owner,"/roles",401);

  phaseIs("owner-register");
  const registered=await write(owner,"/auth/register",{
    email:"role-owner-"+run+"@example.invalid",
    password:"R0leOwner-"+run,
    companyName:"Disposable multi-role audit "+run.slice(0,7)
  });
  const tenantA=registered.auth.tenantId;
  const ownerMembership=registered.auth.membershipId;
  assert.equal(registered.auth.isOwner,true);
  await modify(owner,"/customization/business-vertical",{verticalCode:"GENERAL"});
  const roles=await read(owner,"/roles");
  const roleByCode=new Map(roles.map(r=>[r.code,r]));
  const expectedRoles=[
    "OWNER","ADMIN","SALES_HEAD","SALES_MANAGER",
    "PROCUREMENT","WAREHOUSE","FINANCE","VIEWER","SERVICE_STAFF"
  ];
  for(const code of expectedRoles)
    assert.ok(roleByCode.has(code),"Role was not seeded: "+code);

  phaseIs("owner-create-data");
  const ownerDeal=await write(owner,"/crm/deals",{
    title:"PRIVATE OWNER DEAL "+run.slice(0,6),amountMinor:"124000"
  });
  assert.ok(ownerDeal.id);
  const warehouse=await write(owner,"/inventory/warehouses",{
    name:"Disposable warehouse "+run.slice(0,6),
    code:"R"+run.slice(0,7).toUpperCase()
  });
  const product=await write(owner,"/catalog/products",{
    name:"Disposable stock "+run.slice(0,6),kind:"STOCKABLE",
    salePriceMinor:"10000",costPriceMinor:"6000"
  });
  assert.ok(warehouse.id&&product.skuId);
  const service=await write(owner,"/service/catalog",{
    name:"Disposable employee service "+run.slice(0,6),
    durationMinutes:60,priceMinor:"250000",currency:"RUB"
  });
  assert.ok(service.id);

  phaseIs("owner-invites-viewers");
  async function invite(user,slug){
    const email=slug+"-"+run+"@example.invalid";
    const token=await write(owner,"/tenants/invite",{email});
    assert.ok(token.oneTimeToken?.length>=32);
    const joined=await write(user,"/auth/register-invited",{
      email,password:"RoleStaff-"+run,invitationToken:token.oneTimeToken
    });
    assert.equal(joined.auth.tenantId,tenantA);
    assert.equal(joined.auth.isOwner,false);
    const me=await read(user,"/auth/me");
    assert.equal(me.auth.isOwner,false);
    return joined.auth.membershipId;
  }
  const employeeMembership=await invite(employee,"role-employee");
  const colleagueMembership=await invite(colleague,"role-colleague");
  // A second concurrently active manager allows testing the OWN scope
  // against a genuine colleague, not just the company owner.
  await modify(owner,"/roles/assign",{
    membershipId:colleagueMembership,
    roleId:roleByCode.get("SALES_MANAGER").id
  });
  const colleagueDeal=await write(colleague,"/crm/deals",{
    title:"Other salesperson deal "+run.slice(0,6),amountMinor:"45000"
  });
  assert.ok(colleagueDeal.id);
  await read(employee,"/tenants/team",403);
  await read(employee,"/finance/summary",403);
  await write(employee,"/catalog/products",{
    name:"Should never be created",kind:"STOCKABLE"
  },403);

  phaseIs("permissions-scope");
  // The same actual HTTP session changes role; privilege caches and old
  // sessions must not retain previous grants.
  const rolesToCycle=[
    "VIEWER","SALES_MANAGER","SALES_HEAD","PROCUREMENT",
    "WAREHOUSE","FINANCE","SERVICE_STAFF","ADMIN","VIEWER"
  ];
  let inventoryChanged=false,financeChanged=false,ownedDealId=null;
  for(const code of rolesToCycle){
    const context=await verifyRole(code,roleByCode.get(code).id,employeeMembership);
    await permissionGate(context,"crm.read","/crm/board");
    await permissionGate(context,"catalog.read","/catalog/products");
    await permissionGate(context,"inventory.read","/inventory/balances");
    await permissionGate(context,"finance.read","/finance/summary");
    await permissionGate(context,"service.read","/service/bookings");
    await permissionGate(context,"roles.manage","/roles");
    await permissionGate(context,"users.manage","/tenants/team");
    // Scope is not only route authorization: OWN must hide colleague's deal.
    if(code==="SALES_MANAGER"){
      assert.equal(hasPermission(context,"crm.read"),"own");
      const board=await read(employee,"/crm/board");
      assert.equal(board.stages.some(s=>s.deals.some(d=>d.id===ownerDeal.id)),
        false,"Sales manager must not see owner-assigned CRM deal");
      assert.equal(board.stages.some(s=>s.deals.some(d=>d.id===colleagueDeal.id)),
        false,"Sales manager must not see colleague-assigned CRM deal");
      const own=await write(employee,"/crm/deals",{
        title:"Staff owned "+run.slice(0,6),amountMinor:"50000"
      });
      ownedDealId=own.id;
      assert.ok(board.stages.every(s=>s.deals.every(d=>d.id!==ownerDeal.id)));
    }
    if(code==="SALES_HEAD"){
      assert.equal(hasPermission(context,"crm.read"),"all");
      const board=await read(employee,"/crm/board");
      assert.ok(board.stages.some(s=>s.deals.some(d=>d.id===ownerDeal.id)));
      assert.ok(board.stages.some(s=>s.deals.some(d=>d.id===ownedDealId)));
      assert.ok(board.stages.some(s=>s.deals.some(d=>d.id===colleagueDeal.id)));
    }
    if(code==="WAREHOUSE"){
      assert.equal(hasPermission(context,"inventory.write"),"all");
      const adjustment=await write(employee,"/inventory/adjustments",{
        warehouseId:warehouse.id,skuId:product.skuId,
        quantityDeltaMilli:"1000",reason:"Disposable warehouse operator",
        idempotencyKey:"role-stock-"+run
      });
      assert.ok(adjustment.movementId);
      inventoryChanged=true;
      await read(employee,"/finance/summary",403);
    }
    if(code==="FINANCE"){
      assert.equal(hasPermission(context,"finance.write"),"all");
      const account=await write(employee,"/finance/accounts",{
        name:"Disposable finance role "+run.slice(0,6),
        kind:"BANK",currency:"RUB"
      });
      assert.ok(account.id);
      financeChanged=true;
      await read(employee,"/inventory/balances",403);
    }
    if(code==="SERVICE_STAFF"){
      assert.equal(hasPermission(context,"service.read"),"own");
      assert.equal(hasPermission(context,"finance.read"),null);
      await read(employee,"/finance/summary",403);
      await read(employee,"/service/bookings");
    }
    if(code==="ADMIN"){
      // Even an administrator with roles.manage cannot forge ownership.
      await mustDeny(employee,"PUT","/roles/assign",{
        membershipId:employeeMembership,roleId:roleByCode.get("OWNER").id
      });
      const me=await read(employee,"/auth/me");
      assert.equal(me.auth.isOwner,false);
    }
    if(code==="VIEWER"){
      assert.equal(hasPermission(context,"inventory.write"),null);
      assert.equal(hasPermission(context,"finance.write"),null);
      await mustDeny(employee,"POST","/inventory/adjustments",{
        warehouseId:warehouse.id,skuId:product.skuId,
        quantityDeltaMilli:"1000",reason:"Forbidden role"
      });
    }
  }
  assert.equal(inventoryChanged,true);
  assert.equal(financeChanged,true);
  for(const code of expectedRoles.filter(code=>code!=="OWNER"))
    assert.ok(observed.has(code),"Role not exercised: "+code);
  phaseIs("cannot-mint-owner");
  await mustDeny(owner,"PUT","/roles/assign",{
    membershipId:colleagueMembership,roleId:roleByCode.get("OWNER").id
  });
  // A permitted manager also cannot replace another tenant owner's identity.
  phaseIs("second-tenant-isolation");
  role="OWNER";
  const other=await write(owner,"/tenants",{
    name:"Disposable separate company "+run.slice(0,6)
  });
  assert.notEqual(other.tenantId,tenantA);
  assert.equal((await read(owner,"/auth/me")).auth.tenantId,other.tenantId);
  const otherDeal=await write(owner,"/crm/deals",{
    title:"Other tenant confidential deal "+run.slice(0,6),
    amountMinor:"999000"
  });
  const otherRoles=await read(owner,"/roles");
  // The staff has no membership in the second tenant.
  await api(employee,"POST","/auth/switch-tenant",{
    membershipId:other.membershipId
  },401);
  assert.equal((await read(employee,"/auth/me")).auth.tenantId,tenantA);
  const foreignBoard=await read(employee,"/crm/board");
  assert.equal(foreignBoard.stages.some(s=>s.deals.some(d=>d.id===otherDeal.id)),
    false,"Other company CRM deal must not leak");
  await read(employee,"/crm/deals/"+otherDeal.id,[403,404]);
  await modify(owner,"/roles/assign",{
    membershipId:employeeMembership,roleId:otherRoles.find(r=>r.code==="VIEWER").id
  },404);
  await write(owner,"/auth/switch-tenant",{membershipId:ownerMembership});
  assert.equal((await read(owner,"/auth/me")).auth.tenantId,tenantA);
  const originalBoard=await read(owner,"/crm/board");
  assert.ok(originalBoard.stages.some(s=>s.deals.some(d=>d.id===ownerDeal.id)));
  const actorContext=await read(employee,"/workspace/context");
  assert.deepEqual(actorContext.roles,["VIEWER"]);
  await read(employee,"/finance/summary",403);
  // Logout revokes access for the same cookie, not merely local UI state.
  phaseIs("logout-revocation");
  await write(employee,"/auth/logout",{});
  await read(employee,"/auth/me",401);
  await read(employee,"/workspace/context",401);
  assert.equal((await read(owner,"/auth/me")).auth.isOwner,true);
  process.stdout.write(JSON.stringify({
    result:"PASS",mode:"DISPOSABLE_MULTI_ROLE_API_E2E",
    observedRoles:[...observed].sort(),companies:2,
    registeredAccounts:3,checks:audit.length,
    positiveChecks:audit.filter(x=>x.status<300).length,
    denialChecks:audit.filter(x=>x.status>=400).length,
    invariantChecks:[
      "role changes take effect on current session",
      "crm own/all scope enforced against owner and colleague",
      "admin cannot mint OWNER",
      "owner cannot assign OWNER to a nonowner",
      "worker finance isolation",
      "warehouse and finance positive writes",
      "cross-tenant references denied",
      "logout revokes the session"
    ],
    note:"Only local disposable API; no production guarantees or PSP/KKT validation"
  },null,2)+"\n");
}
main().catch(error=>{
  // Never include bearer cookie, invitation token or raw HTTP bodies.
  process.stderr.write("MULTI_ROLE_FAIL phase="+phase+" role="+role+
    " reason="+String(error?.message??"unknown").slice(0,400)+"\n");
  process.exitCode=1;
});
