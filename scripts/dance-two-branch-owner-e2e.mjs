#!/usr/bin/env node
/**
 * Moscow dance-studio owner: two branches, twelve directions, fifty-two
 * coaches, three leased halls in branch A, two 2/2 receptionists, parent portal.
 * A MUTATING test for ONE newly provisioned disposable Postgres + Redis.
 * Its reported outcome is NOT commercial GO: rent for branch B, taxes and
 * real card payments are unknown until the operator configures providers.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

assert.equal(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB,"YES","Disposable DB confirmation required");
assert.ok(process.env.COREBIZ_SMOKE_BASE_URL,"Local API required");
const base=new URL(process.env.COREBIZ_SMOKE_BASE_URL);
assert.equal(base.protocol,"http:");
assert.ok(["localhost","127.0.0.1","[::1]"].includes(base.hostname));
assert.equal(base.search,"");assert.equal(base.hash,"");
const origin=process.env.COREBIZ_SMOKE_WEB_ORIGIN??"http://localhost:3000";
const seed=randomUUID();
const actors={owner:{cookie:""},woman:{cookie:""},m1:{cookie:""},m2:{cookie:""},parent:{cookie:""}};
let stage="health";
const stats={branches:0,directions:0,trainerResources:0,rooms:0,
  contracts:0,groups:0,customers:0,customerLogins:0,checks:0,denied:0};
const api=async(actor,method,path,body,expected=method==="POST"?201:200)=>{
  const response=await fetch(new URL("/api/v1"+path,base),{
    method,redirect:"error",signal:AbortSignal.timeout(30000),
    headers:{Origin:origin,...(actor.cookie?{Cookie:actor.cookie}:{}),
      ...(body===undefined?{}:{"Content-Type":"application/json"})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const setCookie=response.headers.get("set-cookie");
  if(setCookie?.startsWith("corebiz_session="))actor.cookie=setCookie.split(";")[0];
  const accepted=Array.isArray(expected)?expected:[expected];
  if(!accepted.includes(response.status))throw new Error(
    stage+" "+method+" "+path.split("?")[0]+" HTTP "+response.status+
    " expected "+accepted.join("/")
  );
  const json=await response.json();
  assert.equal(json.ok,response.status>=200&&response.status<300,
    stage+": invalid JSON envelope");
  stats.checks++;if(response.status>=400)stats.denied++;
  return json.data;
};
const get=(actor,path,expected=200)=>api(actor,"GET",path,undefined,expected);
const post=(actor,path,body,expected=201)=>api(actor,"POST",path,body,expected);
const put=(actor,path,body,expected=200)=>api(actor,"PUT",path,body,expected);
async function inviteRole(actor,slug,roleId){
  const email="dance-"+slug+"-"+seed+"@example.invalid";
  const invitation=await post(actors.owner,"/tenants/invite",{email,roleId});
  assert.ok(invitation.oneTimeToken?.length>=32);
  const registered=await post(actor,"/auth/register-invited",{
    email,password:"Studio-"+seed,invitationToken:invitation.oneTimeToken
  });
  assert.equal(registered.auth.isOwner,false);
  return registered.auth.membershipId;
}
const programs=[
  "Хип-хоп","Контемпорари","Балет","Стретчинг","Брейкинг",
  "Джаз-фанк","Латина","Сальса","Бачата","High Heels",
  "Танцы для детей","Танцевальная гимнастика"
];
const money=(rub)=>String(BigInt(rub)*100n);
const budget={
  incomeMonthlyMinor:money(3000000),
  groupVisitMinor:money(2400),
  tenVisitPackageMinor:money(7000),
  individualVisitMinor:money(3500),
  leaseAFirstMinor:money(400000),
  leaseAOtherMinor:money(150000),
  managerMonthlyTotalMinor:money(100000)
};
async function main(){
  const owner=actors.owner;
  stage="01 health";
  assert.equal((await get(owner,"/health/ready")).status,"ok");
  stage="02 owner and niche";
  const registered=await post(owner,"/auth/register",{
    email:"dance-owner-"+seed+"@example.invalid",
    password:"Owner-"+seed,companyName:"Московская танцевальная студия "+seed.slice(0,7)
  });
  const tenant=registered.auth.tenantId;
  assert.equal(registered.auth.isOwner,true);
  assert.equal((await put(owner,"/customization/business-vertical",{
    verticalCode:"DANCE_FITNESS"
  })).verticalCode,"DANCE_FITNESS");
  const roles=await get(owner,"/roles");
  const role=(code)=>{
    const x=roles.find(r=>r.code===code);
    assert.ok(x,"System role missing: "+code+"; apply migrations");
    return x.id;
  };
  stage="03 managers, second founder and parent";
  const manager1=await inviteRole(actors.m1,"manager1",role("DANCE_MANAGER"));
  const manager2=await inviteRole(actors.m2,"manager2",role("DANCE_MANAGER"));
  const woman=await inviteRole(actors.woman,"woman-founder",role("ADMIN"));
  const parent=await inviteRole(actors.parent,"parent",role("DANCE_CUSTOMER"));
  assert.ok(manager1&&manager2&&woman&&parent);
  assert.equal((await get(actors.m1,"/workspace/context")).roles[0],"DANCE_MANAGER");
  assert.equal((await get(actors.parent,"/workspace/context")).roles[0],"DANCE_CUSTOMER");
  await get(actors.m1,"/finance/summary",403);
  await get(actors.parent,"/crm/board",403);
  await get(actors.parent,"/dance/students",403);
  await get(actors.parent,"/dance/portal/me",403); // no verified CRM link yet

  stage="04 organization and two Moscow branches";
  const legal=await post(owner,"/organization/legal-entities",{
    name:"Одноразовый учебный субъект",inn:"1234567894",kpp:"770701001"
  });
  const branches=[];
  for(const name of ["Москва, филиал А","Москва, филиал Б"]){
    const created=await post(owner,"/organization/branches",{
      name:name+" "+seed.slice(0,7),legalEntityId:legal.id
    });
    branches.push(created);stats.branches++;
  }
  const large=await post(owner,"/service/resources",{
    type:"HALL",name:"Большой зал A",branchId:branches[0].id,
    timezone:"Europe/Moscow",capacity:24
  });
  const small1=await post(owner,"/service/resources",{
    type:"ROOM",name:"Малый зал A1 (аренда)",branchId:branches[0].id,
    timezone:"Europe/Moscow",capacity:8
  });
  const small2=await post(owner,"/service/resources",{
    type:"ROOM",name:"Малый зал A2 (аренда)",branchId:branches[0].id,
    timezone:"Europe/Moscow",capacity:8
  });
  const hallB=await post(owner,"/service/resources",{
    type:"HALL",name:"Групповой зал B",branchId:branches[1].id,
    timezone:"Europe/Moscow",capacity:20
  });
  stats.rooms=4;
  // Rental pricing was not provided. 1,200 RUB/h is a DISPOSABLE
  // test-only assumption. Production owner must explicitly set market rates.
  stage="04a hypothetical small-hall rentals";
  const rentServices=[];
  for(const [index,room] of [small1,small2].entries()){
    const rental=await post(owner,"/service/catalog",{
      name:"TEST аренда малого зала "+(index+1)+" (условный прайс)",
      category:"Аренда залов",durationMinutes:60,
      priceMinor:money(1200),deliveryFormat:"RENTAL",groupCapacity:8
    });
    rentServices.push({serviceId:rental.id,resourceId:room.id});
  }
  const tenantRenter=await post(owner,"/crm/customers",{
    type:"PERSON",displayName:"Тестовый арендатор "+seed.slice(0,6)
  });
  const rentStart=new Date();
  rentStart.setUTCDate(rentStart.getUTCDate()+19);
  rentStart.setUTCHours(10,0,0,0);
  const createdRentBookings=[];
  for(const [index,rental] of rentServices.entries()){
    const booking=await post(owner,"/service/bookings",{
      serviceId:rental.serviceId,
      branchId:branches[0].id,
      partyId:tenantRenter.id,
      deliveryFormat:"RENTAL",
      startsAt:rentStart.toISOString(),
      resources:[{resourceId:rental.resourceId,capacityUnits:8}],
      idempotencyKey:"dance-rental-"+index+"-"+seed,
      notes:"Only disposable capacity test; no verified payment"
    });
    createdRentBookings.push(booking);
  }
  assert.equal(createdRentBookings.length,2);
  await post(owner,"/service/bookings",{
    serviceId:rentServices[0].serviceId,branchId:branches[0].id,
    partyId:tenantRenter.id,deliveryFormat:"RENTAL",
    startsAt:rentStart.toISOString(),
    resources:[{resourceId:small1.id,capacityUnits:8}],
    idempotencyKey:"dance-rental-conflict-"+seed
  },409);

  const contracts=[];
  for(const [room,cost,units] of [
    [large,budget.leaseAFirstMinor,24],[small1,budget.leaseAOtherMinor,8],
    [small2,budget.leaseAOtherMinor,8]
  ]){
    const agreement=await post(owner,"/dance/room-contracts",{
      roomResourceId:room.id,pricingType:"FIXED_MONTHLY",
      monthlyMinor:cost,validFrom:"2026-10-01",
      capacityUnits:units
    });
    contracts.push(agreement);stats.contracts++;
  }
  assert.equal(contracts.length,3);
  assert.equal(BigInt(budget.leaseAFirstMinor)+2n*BigInt(budget.leaseAOtherMinor),
    70000000n,"Branch A monthly rent is 700k RUB");
  // Branch B rent was not supplied by the owner; never book fictitious zero.
  stage="05 52 trainers, including the two business founders";
  const trainers=[];
  for(let i=0;i<52;i++){
    const r=await post(owner,"/service/resources",{
      type:"EMPLOYEE",branchId:branches[i<2?0:i%2].id,
      membershipId:i===0?registered.auth.membershipId:
        i===1?woman:undefined,
      timezone:"Europe/Moscow",capacity:1,
      name:i===0?"Владелец-тренер":i===1?"Совладелица-тренер":
        "Тренер "+String(i-1).padStart(2,"0")
    });
    trainers.push(r);stats.trainerResources++;
  }
  assert.equal(trainers.length,52);
  const receptionistResources=[];
  for(const [i,mid] of [manager1,manager2].entries()){
    receptionistResources.push(await post(owner,"/service/resources",{
      type:"EMPLOYEE",branchId:branches[i].id,
      membershipId:mid,timezone:"Europe/Moscow",
      name:"Менеджер 2/2 №"+(i+1)
    }));
  }
  // Real server-enforced two-on/two-off roster, with existing vacations intact.
  const anchor=new Date();anchor.setUTCHours(0,0,0,0);
  const startDate=anchor.toISOString().slice(0,10);
  for(const [i,resource] of receptionistResources.entries()){
    const calendar=await post(owner,"/service/resources/"+resource.id+
      "/two-by-two",{
        startDate,days:60,startsWorking:i===0,
        startMinute:540,endMinute:1260
      });
    assert.equal(calendar.days,60);
    assert.equal(calendar.blockedDays,30);
    const weekly=await get(owner,"/service/resources/"+resource.id+"/schedule");
    assert.equal(weekly.length,7);
    const blocks=await get(owner,"/service/resources/"+resource.id+"/blocks?from="+
      encodeURIComponent(startDate+"T00:00:00Z")+"&to="+
      encodeURIComponent(new Date(anchor.getTime()+61*86400000).toISOString()));
    assert.ok(blocks.filter(x=>x.reason==="COREBIZ_2X2_MANAGER_OFF").length>=29);
  }

  stage="06 12 directions, service prices, groups";
  const createdPrograms=[];
  let groupForParent;
  let groupLesson;
  for(let i=0;i<programs.length;i++){
    const service=await post(owner,"/service/catalog",{
      name:programs[i]+" групповое",category:programs[i],
      durationMinutes:60,priceMinor:budget.groupVisitMinor,
      currency:"RUB",deliveryFormat:"GROUP",groupCapacity:16
    });
    const created=await post(owner,"/dance/programs",{
      name:programs[i],serviceId:service.id,branchId:branches[i<2?0:i%2].id,
      defaultDurationMinutes:60
    });
    createdPrograms.push(created);stats.directions++;
    const g=await post(owner,"/dance/groups",{
      name:programs[i]+" группа "+(i+1),
      programId:created.id,branchId:branches[i<2?0:i%2].id,
      trainerResourceId:trainers[i].id,
      roomResourceId:i<2||i%2===0?large.id:hallB.id,
      capacity:16,breakEvenMembers:8,
      schedule:[{weekday:(i%5)+1,startMinute:660+(i%3)*120,
        durationMinutes:60}]
    });
    stats.groups++;
    if(i===0)groupForParent=g;
  }
  assert.equal(createdPrograms.length,12);
  assert.ok(groupForParent?.id);
  const oneVisit=await post(owner,"/service/package-plans",{
    name:"Разовое групповое 2 400 ₽",packageKind:"VISITS",
    visitLimit:1,durationDays:30,priceMinor:budget.groupVisitMinor,
    activationPolicy:"FULL_PAYMENT"
  });
  const tenVisits=await post(owner,"/service/package-plans",{
    name:"10 групповых — 7 000 ₽",packageKind:"VISITS",
    visitLimit:10,durationDays:120,
    priceMinor:budget.tenVisitPackageMinor,
    managementVisitValueMinor:money(700),
    activationPolicy:"FULL_PAYMENT",
    noShowPolicy:"RELEASE"
  });
  const individual=await post(owner,"/service/catalog",{
    name:"Индивидуальное занятие",category:"Индивидуальные",
    durationMinutes:60,priceMinor:budget.individualVisitMinor,
    deliveryFormat:"INDIVIDUAL"
  });
  assert.ok(oneVisit.id&&tenVisits.id&&individual.id);
  stage="07 CRM family, memberships and client portal";
  const mother=await post(actors.m1,"/crm/customers",{
    type:"PERSON",displayName:"Мама тестового ученика "+seed.slice(0,6)
  });
  const child=await post(actors.m1,"/crm/customers",{
    type:"PERSON",displayName:"Ученик тестовый "+seed.slice(0,6)
  });
  const student=await post(actors.m1,"/dance/students",{
    partyId:child.id,payerPartyId:mother.id,
    payerRelation:"PARENT",status:"ACTIVE",
    preferredBranchId:branches[0].id
  });
  stats.customers=2;
  const familyPackage=await post(actors.m1,"/service/packages",{
    planId:tenVisits.id,partyId:child.id,payerPartyId:mother.id
  });
  assert.ok(familyPackage.id);
  // FULL_PAYMENT means the package is not an active visit entitlement
  // until actual finance confirmation; issuing it is not proof of payment.
  await post(actors.m1,"/dance/groups/"+groupForParent.id+"/members",{
    studentId:student.id,status:"ACTIVE"
  });
  // Generate real future group lessons: client portal must show dates,
  // room and the assigned coach, not just a CRM/group membership.
  const firstDate=new Date();
  firstDate.setUTCDate(firstDate.getUTCDate()+7);
  const lastDate=new Date(firstDate);
  lastDate.setUTCDate(lastDate.getUTCDate()+21);
  const generated=await post(actors.m1,
    "/dance/groups/"+groupForParent.id+"/lessons/generate",{
      from:firstDate.toISOString().slice(0,10),
      to:lastDate.toISOString().slice(0,10)
    });
  assert.ok(generated.created.length>0,
    "A future dated lesson is required for a real student portal");
  const roster=await get(actors.m1,"/dance/lessons/"+
    generated.created[0].id+"/participants");
  assert.ok(roster.some(p=>p.student_id===student.id),
    "Manager should find child in lesson attendance journal");
  const clientLink=await post(owner,"/dance/portal/link",{
    membershipId:parent,partyId:mother.id
  });
  assert.equal(clientLink.linked,true);
  stats.customerLogins=1;
  const portal=await get(actors.parent,"/dance/portal/me");
  assert.ok(portal.students.some(x=>x.id===student.id));
  assert.ok(portal.groups.some(x=>x.student_id===student.id));
  assert.ok(portal.packages.some(x=>x.id===familyPackage.id));
  assert.ok(portal.visits.some(x=>x.student_id===student.id),
    "Client should see actual Moscow lesson dates and trainer");
  stage="07b parent privacy, another family and revocation";
  const otherPayer=await post(owner,"/crm/customers",{
    type:"PERSON",displayName:"Посторонний плательщик "+seed.slice(0,6)
  });
  const otherChild=await post(owner,"/crm/customers",{
    type:"PERSON",displayName:"Чужой ученик "+seed.slice(0,6)
  });
  const otherStudent=await post(owner,"/dance/students",{
    partyId:otherChild.id,payerPartyId:otherPayer.id,
    payerRelation:"PARENT",status:"ACTIVE",
    preferredBranchId:branches[1].id
  });
  assert.ok(otherStudent.id);
  stats.customers+=2;
  const secondFamilyView=await get(actors.parent,"/dance/portal/me");
  assert.equal(secondFamilyView.students.some(x=>x.id===otherStudent.id),false,
    "Another parent's child must never appear in this portal");
  assert.equal(secondFamilyView.students.every(x=>x.id===student.id),true);
  await post(actors.m1,"/dance/portal/accounts/"+parent+"/revoke",{},403);
  const links=await get(owner,"/dance/portal/accounts");
  assert.ok(links.some(x=>x.membership_id===parent&&x.status==="ACTIVE"));
  const revoked=await post(owner,"/dance/portal/accounts/"+parent+"/revoke",{});
  assert.equal(revoked.revoked,true);
  await get(actors.parent,"/dance/portal/me",403);
  await post(owner,"/dance/portal/link",{
    membershipId:parent,partyId:mother.id
  });
  const restoredPortal=await get(actors.parent,"/dance/portal/me");
  assert.ok(restoredPortal.students.some(x=>x.id===student.id));
  await get(actors.parent,"/finance/summary",403);
  await get(actors.parent,"/dance/charges",403);
  const receivables=await get(actors.m1,"/dance/charges");
  assert.ok(Array.isArray(receivables));
  await get(actors.m1,"/finance/summary",403);
  await get(actors.m2,"/dance/students");
  stage="08 owner control and expense isolation";
  const cofounderCalendar=await get(actors.woman,
    "/dance/trainer/me?from="+firstDate.toISOString().slice(0,10)+
    "&to="+lastDate.toISOString().slice(0,10));
  assert.equal(cofounderCalendar.trainer.id,trainers[1].id,
    "Partner ADMIN is a teacher in the same Moscow branch");
  assert.ok(cofounderCalendar.lessons.every(x=>
    !Object.prototype.hasOwnProperty.call(x,"amount_minor")),
    "Cofounder personal calendar must not expose financial ledger");
  const access=await get(owner,"/dance/access");
  assert.equal(access.canViewFinance,true);
  const finance=await get(owner,"/dance/dashboard");
  assert.equal(finance.canViewFinancials,true);
  const managerDashboard=await get(actors.m1,"/dance/dashboard");
  assert.equal(managerDashboard.canViewFinancials,false);
  const controllerHealth=await get(owner,"/dance/operations/health");
  assert.ok(controllerHealth.status);
  const waiting=await get(owner,"/dance/readiness");
  assert.ok(Array.isArray(waiting.steps));
  const stored=await get(owner,"/dance/room-contracts");
  assert.ok(stored.length>=3);
  const allTrainers=await get(owner,"/service/resources");
  assert.ok(allTrainers.filter(x=>x.type==="EMPLOYEE").length>=54);
  stage="08a coach account sees only personal lessons";
  // Reuse manager-2's existing login after receptionist tests. This keeps
  // five registrations/IP and proves that demotion immediately revokes
  // broader receptionist privileges without deleting historical schedules.
  const trainerOwnGroup=await post(owner,"/dance/groups",{
    name:"Тренер: личная загрузка",
    programId:createdPrograms[3].id,branchId:branches[1].id,
    trainerResourceId:receptionistResources[1].id,
    roomResourceId:hallB.id,capacity:10,breakEvenMembers:4,
    schedule:[{weekday:6,startMinute:1140,durationMinutes:60}]
  });
  assert.ok(trainerOwnGroup.id);
  const ownStart=new Date();ownStart.setUTCDate(ownStart.getUTCDate()+3);
  const ownEnd=new Date(ownStart.getTime()+31*86400000);
  const generatedTrainer=await post(owner,
    "/dance/groups/"+trainerOwnGroup.id+"/lessons/generate",{
      from:ownStart.toISOString().slice(0,10),
      to:ownEnd.toISOString().slice(0,10)
    });
  assert.ok(generatedTrainer.created.length>0,
    "A trainer calendar needs an actual future lesson");
  await put(owner,"/roles/assign",{
    membershipId:manager2,roleId:role("DANCE_TRAINER")
  });
  const coachContext=await get(actors.m2,"/workspace/context");
  assert.deepEqual(coachContext.roles,["DANCE_TRAINER"]);
  const personal=await get(actors.m2,"/dance/trainer/me?from="+
    ownStart.toISOString().slice(0,10)+"&to="+
    ownEnd.toISOString().slice(0,10));
  assert.equal(personal.trainer.id,receptionistResources[1].id);
  assert.ok(personal.lessons.length>0);
  assert.ok(personal.lessons.every(x=>!Object.prototype.hasOwnProperty.call(x,"party_id")&&
    !Object.prototype.hasOwnProperty.call(x,"amount_minor")));
  await get(actors.m2,"/dance/groups",403);
  await get(actors.m2,"/dance/charges",403);
  await get(actors.m2,"/finance/summary",403);
  await get(actors.m2,"/tenants/team",403);
  stage="09 negative archival: reassignment required";
  await post(owner,"/service/resources/"+trainers[0].id+"/archive",
    {},409);
  stage="09b revoke and recover parent portal access";
  const listedAccounts=await get(owner,"/dance/portal/accounts");
  assert.ok(listedAccounts.some(x=>x.membership_id===parent&&
    x.status==="ACTIVE"));
  const revoked=await post(owner,
    "/dance/portal/accounts/"+parent+"/revoke",{});
  assert.equal(revoked.revoked,true);
  await get(actors.parent,"/dance/portal/me",403);
  await get(actors.parent,"/crm/board",403);
  const restored=await post(owner,"/dance/portal/link",{
    membershipId:parent,partyId:mother.id
  });
  assert.equal(restored.linked,true);
  const recovered=await get(actors.parent,"/dance/portal/me");
  assert.ok(recovered.students.some(x=>x.id===student.id));
  assert.ok(recovered.packages.every(p=>
    p.party_id===null||p.party_id===child.id));
  // One login must never acquire company finance access through relinking.
  await get(actors.parent,"/finance/summary",403);
  stage="10 validation of known financial uncertainties";
  const result={
    mode:"DISPOSABLE_DANCE_OWNER_SIMULATION",
    result:"PARTIAL_PASS_NO_COMMERCIAL_GO",
    tenantId:tenant,stats,
    businessFacts:{
      MoscowBranches:2,directions:12,trainerResources:52,
      branchAHalls:3,monthlyRentBranchARub:700000,
      receptionistMonthlyRub:100000,monthlyTurnoverTargetRub:3000000,
      groupSingleRub:2400,tenVisitsRub:7000,individualRub:3500
    },
    outstanding:[
      "Rent and expense assumptions for branch B unknown",
      "Real trainer compensation rules and wage taxes not configured",
      "2/2 schedules materialized for 60 days; extend before the end or implement recurring horizon jobs",
      "1,200 RUB/h rental bookings are disposable test assumptions, not signed prices",
      "Rental sale price and signed sublease terms for small halls unknown",
      "Full-payment package cannot be treated as paid without PSP reconciliation",
      "Partner has ADMIN role but formal second OWNER cannot yet be granted",
      "49+ trainers are staff resources without their own invited login",
      "No external PSP/KKT/FNS or production load tests run"
    ]
  };
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
}
main().catch(e=>{
  process.stderr.write("DANCE_OWNER_E2E_FAIL stage="+stage+
    " reason="+String(e?.message??"unknown").slice(0,340)+"\n");
  process.exitCode=1;
});
