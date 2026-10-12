#!/usr/bin/env node
/**
 * Disposable end-to-end OWNER business setup simulation.
 * Registration -> company -> sector -> team -> CRM -> inventory -> store
 * -> second (service) company -> scheduling -> tenant isolation -> switch back.
 * Creates test tenants, employees, objects and a booking. NEVER use on live DB.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

assert.equal(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB,"YES",
  "BLOCKED: the API must run against an explicitly disposable DB");
const raw=process.env.COREBIZ_SMOKE_BASE_URL;
assert.ok(raw,"COREBIZ_SMOKE_BASE_URL is required");
const base=new URL(raw);
assert.equal(base.protocol,"http:","Local HTTP test stack only");
assert.ok(["localhost","127.0.0.1","[::1]"].includes(base.hostname),
  "BLOCKED: owner setup simulation cannot contact external servers");
assert.equal(base.username,"");
assert.equal(base.password,"");
assert.equal(base.search,"");
assert.equal(base.hash,"");
const origin=process.env.COREBIZ_SMOKE_WEB_ORIGIN??"http://localhost:3000";
const run=randomUUID();
const ownerEmail="owner-setup-"+run+"@example.invalid";
const employeeEmail="staff-setup-"+run+"@example.invalid";
const owner={cookie:""};
const employee={cookie:""};
const steps=[];
let stage="preflight";
let current="bootstrap";
function step(name){stage=name;}
async function api(who,method,path,data,expected=200){
  const started=performance.now();
  const response=await fetch(new URL("/api/v1"+path,base),{
    method,redirect:"error",signal:AbortSignal.timeout(25000),
    headers:{
      Origin:origin,
      ...(who.cookie?{Cookie:who.cookie}:{}),
      ...(data===undefined?{}:{"Content-Type":"application/json"})
    },
    ...(data===undefined?{}:{body:JSON.stringify(data)})
  });
  const setCookie=response.headers.get("set-cookie");
  if(setCookie?.startsWith("corebiz_session="))
    who.cookie=setCookie.split(";")[0];
  const rawText=await response.text();
  let payload;
  try{payload=JSON.parse(rawText);}catch{
    throw new Error(stage+": API returned non-JSON HTTP "+response.status);
  }
  const allowed=Array.isArray(expected)?expected:[expected];
  assert.ok(allowed.includes(response.status),
    stage+": "+method+" "+path+" HTTP "+response.status+
    " expected "+allowed.join("/")+" ("+
    (payload.error?.code??"unspecified")+")");
  assert.equal(payload.ok,response.status>=200&&response.status<300,
    stage+": unexpected API envelope on "+path);
  steps.push({stage,method,path:path.split("?")[0],
    status:response.status,elapsedMs:Math.round(performance.now()-started)});
  return payload.data;
}
const get=(who,path)=>api(who,"GET",path);
const post=(who,path,data)=>api(who,"POST",path,data);
const put=(who,path,data)=>api(who,"PUT",path,data);
function containsId(list,id,label){
  assert.ok(Array.isArray(list),label+" must return array");
  assert.ok(list.some(x=>x.id===id),label+" must include created object");
}
async function main(){
  step("01 readiness");
  const health=await get(owner,"/health/ready");
  assert.equal(health.status,"ok");

  step("02 registration and session");
  await api(owner,"GET","/auth/me",undefined,401);
  await api(owner,"POST","/auth/register",{
    email:"not-an-email",password:"short",companyName:"X"
  },400);
  const registered=await post(owner,"/auth/register",{
    email:ownerEmail,password:"Owner-"+run,
    companyName:"Test owner electronics "+run.slice(0,8)
  });
  assert.ok(registered.auth?.tenantId);
  assert.equal(registered.auth?.isOwner,true);
  const firstTenant=registered.auth.tenantId;
  const firstMembership=registered.auth.membershipId;
  const whoAmI=await get(owner,"/auth/me");
  assert.equal(whoAmI.auth.tenantId,firstTenant);
  assert.equal(whoAmI.auth.isOwner,true);

  step("03 business vertical and capabilities");
  const verticals=await get(owner,"/customization/business-verticals");
  assert.ok(verticals.some(x=>x.code==="ECOMMERCE_STORE"));
  const applied=await put(owner,"/customization/business-vertical",{
    verticalCode:"ECOMMERCE_STORE"
  });
  assert.equal(applied.verticalCode,"ECOMMERCE_STORE");
  assert.equal(applied.profileCode,"ECOMMERCE");
  const profile=await get(owner,"/customization/business-profile");
  assert.equal(profile.profileCode,"ECOMMERCE");
  const capabilities=await get(owner,"/customization/capabilities");
  for(const key of ["catalog","inventory","crm","sites"])
    assert.ok(capabilities.some(x=>x.key===key&&x.enabled),
      "New store missing business capability "+key);
  await get(owner,"/dashboard/activation");

  step("04 owner invites staff, staff activates VIEWER");
  const teamBefore=await get(owner,"/tenants/team");
  assert.ok(teamBefore.some(x=>x.email===ownerEmail));
  const invite=await post(owner,"/tenants/invite",{email:employeeEmail});
  assert.ok(invite.oneTimeToken?.length>=32);
  assert.ok(invite.invitationId);
  const joined=await post(employee,"/auth/register-invited",{
    email:employeeEmail,password:"Staff-"+run,
    invitationToken:invite.oneTimeToken
  });
  // Secret is deliberately not logged, stored in evidence, or printed.
  assert.equal(joined.auth.tenantId,firstTenant);
  assert.equal(joined.auth.isOwner,false);
  const employeeMe=await get(employee,"/auth/me");
  assert.equal(employeeMe.auth.tenantId,firstTenant);
  assert.equal(employeeMe.auth.isOwner,false);
  await api(employee,"POST","/catalog/products",{
    name:"Unauthorized staff product",kind:"STOCKABLE"
  },403);
  await api(employee,"GET","/tenants/team",undefined,403);
  const teamAfter=await get(owner,"/tenants/team");
  assert.ok(teamAfter.some(x=>x.email===employeeEmail&&
    x.is_owner===false&&x.status==="ACTIVE"));
  const invitations=await get(owner,"/tenants/invitations");
  assert.ok(invitations.some(x=>x.id===invite.invitationId||
    x.email===employeeEmail),"Accepted invitation must remain in owner history");
  assert.ok(!JSON.stringify(invitations).includes(invite.oneTimeToken),
    "Invitation list must never leak bearer token");

  step("04b organization, branch and team setup");
  // This synthetic checksum-valid INN is ONLY for the disposable database:
  // checksum validity is not FNS registration, PSP or fiscal readiness.
  await api(owner,"POST","/organization/legal-entities",{
    name:"Bad identifier",inn:"1234567890"
  },400);
  const legal=await post(owner,"/organization/legal-entities",{
    name:"Disposable electronics legal entity",
    inn:"1234567894",kpp:"770701001"
  });
  const branch=await post(owner,"/organization/branches",{
    name:"Test showroom branch",legalEntityId:legal.id
  });
  const operatingTeam=await post(owner,"/organization/teams",{
    name:"Sales and pickup team",branchId:branch.id
  });
  const assigned=await post(owner,"/organization/teams/assign",{
    teamId:operatingTeam.id,membershipId:joined.auth.membershipId
  });
  assert.equal(assigned.assigned,true);
  const structure=await get(owner,"/organization");
  assert.ok(structure.legalEntities.some(x=>x.id===legal.id&&
    x.inn==="1234567894"&&x.kpp==="770701001"));
  assert.ok(structure.branches.some(x=>x.id===branch.id&&
    x.legalEntityId===legal.id));
  assert.ok(structure.teams.some(x=>x.id===operatingTeam.id&&x.members>=1));

  step("05 customer and CRM deal");
  const customer=await post(owner,"/crm/customers",{
    type:"ORGANIZATION",displayName:"Test electronics purchaser "+run.slice(0,8)
  });
  assert.ok(customer.id);
  containsId(await get(owner,"/crm/customers"),customer.id,"CRM customers");
  const deal=await post(owner,"/crm/deals",{
    title:"Test B2B laptop request",partyId:customer.id,
    amountMinor:"12990000",source:"MANUAL"
  });
  assert.ok(deal.id);
  await get(owner,"/crm/board");
  const savedDeal=await get(owner,"/crm/deals/"+deal.id);
  assert.ok(savedDeal,"Deal must be available after creation");

  step("06 warehouses, prices, products and stock");
  const warehouse=await post(owner,"/inventory/warehouses",{
    name:"Test main pickup warehouse",code:"T"+run.slice(0,7).toUpperCase()
  });
  assert.ok(warehouse.id);
  containsId(await get(owner,"/inventory/warehouses"),
    warehouse.id,"Warehouses");
  const laptop=await post(owner,"/catalog/products",{
    name:"Test notebook "+run.slice(0,7),kind:"STOCKABLE",
    salePriceMinor:"12990000",costPriceMinor:"10500000",
    description:"Test physical product, not for production"
  });
  const mouse=await post(owner,"/catalog/products",{
    name:"Test mouse "+run.slice(0,7),kind:"STOCKABLE",
    salePriceMinor:"199000",costPriceMinor:"105000"
  });
  assert.ok(laptop.skuId&&mouse.skuId&&laptop.skuId!==mouse.skuId);
  for(const x of [{item:laptop,qty:"3000"},{item:mouse,qty:"12000"}]){
    await post(owner,"/inventory/adjustments",{
      warehouseId:warehouse.id,skuId:x.item.skuId,
      quantityDeltaMilli:x.qty,reason:"Disposable opening balance",
      idempotencyKey:"owner-setup-"+run+"-"+x.item.skuId
    });
  }
  const inventory=await get(owner,"/inventory/balances");
  assert.ok(inventory.some(x=>x.skuId===laptop.skuId&&
    x.warehouseId===warehouse.id&&BigInt(x.physicalMilli)===3000n));
  assert.ok(inventory.some(x=>x.skuId===mouse.skuId&&
    x.warehouseId===warehouse.id&&BigInt(x.physicalMilli)===12000n));

  step("07 site, catalog and fulfilment setup");
  const site=await post(owner,"/sites",{
    name:"Test electronics store "+run.slice(0,8),
    publicSlug:"setup-"+run.replace(/-/g,"").slice(0,20)
  });
  assert.ok(site.id&&site.publicSlug);
  await put(owner,"/storefront/site/"+site.id+"/config",{
    enabled:true,currency:"RUB"
  });
  const pickup=await post(owner,"/payments/stores/"+site.id+"/delivery",{
    code:"OWNER_PICKUP",title:"Test pickup",mode:"PICKUP",
    feeMinor:"0",active:true
  });
  assert.ok(pickup.id);
  const options=await get(owner,"/payments/storefront/"+site.publicSlug+
    "/delivery");
  assert.ok(options.methods.some(x=>x.id===pickup.id&&x.fee_minor==="0"));
  const storefront=await get(owner,"/storefront/"+site.publicSlug+"/catalog");
  assert.ok(storefront.products.some(x=>x.sku_id===laptop.skuId&&
    x.sale_price_minor==="12990000"));
  assert.ok(storefront.products.some(x=>x.sku_id===mouse.skuId));
  const readiness=await get(owner,"/storefront/site/"+site.id+"/readiness");
  assert.ok(readiness&&typeof readiness==="object");
  const sites=await get(owner,"/sites");
  containsId(sites,site.id,"Sites");

  step("08 second company, service sector");
  const second=await post(owner,"/tenants",{
    name:"Test owner beauty salon "+run.slice(0,8)
  });
  assert.ok(second.tenantId&&second.membershipId);
  assert.notEqual(second.tenantId,firstTenant);
  current="second-business";
  const switched=await get(owner,"/auth/me");
  assert.equal(switched.auth.tenantId,second.tenantId);
  const beauty=await put(owner,"/customization/business-vertical",{
    verticalCode:"BEAUTY_SALON"
  });
  assert.equal(beauty.verticalCode,"BEAUTY_SALON");
  assert.equal(beauty.profileCode,"SERVICE");
  const otherProducts=await get(owner,"/catalog/products");
  assert.ok(!otherProducts.some(x=>x.skuId===laptop.skuId),
    "Second tenant must NOT read first tenant's inventory");
  const service=await post(owner,"/service/catalog",{
    name:"Test haircut",code:"CUT-"+run.slice(0,8).toUpperCase(),
    durationMinutes:60,priceMinor:"250000",currency:"RUB"
  });
  const specialist=await post(owner,"/service/resources",{
    type:"EMPLOYEE",name:"Test hairdresser",
    code:"HAIR-"+run.slice(0,7).toUpperCase(),
    capacity:1,timezone:"Europe/Moscow"
  });
  assert.ok(service.id&&specialist.id);
  await put(owner,"/service/resources/"+specialist.id+"/schedule",{
    windows:Array.from({length:7},(_,i)=>({
      weekday:i+1,startMinute:0,endMinute:1440
    }))
  });
  const schedule=await get(owner,"/service/resources/"+specialist.id+"/schedule");
  assert.ok(schedule,"Resource schedule must be retrievable");
  const salonCustomer=await post(owner,"/crm/customers",{
    type:"PERSON",displayName:"Test salon client "+run.slice(0,8)
  });
  const visit=new Date(Date.now()+72*60*60*1000);
  visit.setUTCMinutes(0,0,0);
  const appointment=await post(owner,"/service/bookings",{
    serviceId:service.id,resourceIds:[specialist.id],
    startsAt:visit.toISOString(),partyId:salonCustomer.id,
    source:"API",idempotencyKey:"owner-salon-"+run
  });
  assert.ok(appointment.id);
  const appointmentDetail=await get(owner,"/service/bookings/"+appointment.id);
  assert.equal(appointmentDetail.party_id,salonCustomer.id);
  assert.equal(appointmentDetail.billing?.amountMinor,"250000");
  await get(owner,"/dashboard/activation");

  step("09 cross-company session isolation");
  const employeeAgain=await get(employee,"/auth/me");
  assert.equal(employeeAgain.auth.tenantId,firstTenant);
  await api(employee,"GET","/service/bookings/"+appointment.id,
    undefined,[403,404]);
  const secondOrg=await get(owner,"/organization");
  assert.ok(!secondOrg.legalEntities.some(x=>x.id===legal.id),
    "Legal details must never cross company boundaries");
  const switchResult=await post(owner,"/auth/switch-tenant",{
    membershipId:firstMembership
  });
  assert.equal(switchResult.switched,true);
  current="first-business";
  assert.equal((await get(owner,"/auth/me")).auth.tenantId,firstTenant);
  const backProducts=await get(owner,"/catalog/products");
  assert.ok(backProducts.some(x=>x.skuId===laptop.skuId));
  const returnedTeam=await get(owner,"/tenants/team");
  assert.ok(returnedTeam.some(x=>x.email===employeeEmail));

  step("10 dashboards after setup");
  await get(owner,"/dashboard/owner");
  await get(owner,"/dashboard/activation");
  const summary={
    result:"PASS",mode:"disposable-api-e2e",
    runId:run,
    coverage:{
      companies:2,invitedEmployees:1,legalEntities:1,branches:1,
      operatingTeams:1,crmCustomers:2,crmDeals:1,
      warehouses:1,products:2,openingStockRecords:2,
      publicStorefronts:1,deliveryMethods:1,
      services:1,resources:1,bookings:1
    },
    checks:steps.length,
    note:"No external payment/fiscal/carrier operations performed",
    steps
  };
  process.stdout.write(JSON.stringify(summary,null,2)+"\n");
}
main().catch(err=>{
  // Tokens/cookies/passwords are never included in any diagnostic printout.
  process.stderr.write("OWNER_SETUP_FAIL stage="+stage+" business="+current+
    " error="+(err instanceof Error?err.message:"Unknown failure").slice(0,300)+
    "\n");
  process.exitCode=1;
});
