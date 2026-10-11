import {DanceStudioService} from "./dance-studio.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};

describe("dance operators: privacy boundary",()=>{
  function harness(canReadFinance:boolean,query:(sql:string)=>Promise<any>){
    const client={query:jest.fn(query)};
    const db={withTenantTransaction:jest.fn(async (_ctx:unknown,fn:any)=>fn(client))};
    const auth={
      resolveScope:jest.fn(async (_ctx:unknown,permission:string)=>{
        if(permission==="finance.read")return canReadFinance?"all":null;
        return "all";
      }),
      membershipIdsForScope:jest.fn(async()=>null)
    };
    return {service:new DanceStudioService(db as any,auth as any),client};
  }

  it("teacher sees enrolled names, not parent payer and negotiated discounts",async()=>{
    const {service}=harness(false,async sql=>{
      if(sql.includes("FROM dance_group_member gm"))
        return {rows:[{
          id:"member",student_name:"Мария",payer_party_id:"parent-id",
          payer_name:"Родитель",discount_bps:3000,status:"ACTIVE"
        }]};
      if(sql.includes("FROM dance_group_waitlist w"))
        return {rows:[{id:"wait",student_name:"Игорь",discount_bps:1500}]};
      throw new Error("Unexpected query "+sql.slice(0,75));
    });
    (service as any).assertGroupAccess=jest.fn().mockResolvedValue({id:"group"});
    const result=await service.groupMembers(context,"group");
    expect(result.members[0].student_name).toBe("Мария");
    expect(result.members[0].payer_name).toBeNull();
    expect(result.members[0].payer_party_id).toBeNull();
    expect(result.members[0].discount_bps).toBeNull();
    expect(result.waitlist[0].discount_bps).toBeNull();
  });

  it("finance manager still sees contract payer and real individual discounts",async()=>{
    const {service}=harness(true,async sql=>{
      if(sql.includes("FROM dance_group_member gm"))
        return {rows:[{id:"member",student_name:"Мария",
          payer_name:"Родитель",discount_bps:3000}]};
      return {rows:[]};
    });
    (service as any).assertGroupAccess=jest.fn().mockResolvedValue({id:"group"});
    const result=await service.groupMembers(context,"group");
    expect(result.members[0].payer_name).toBe("Родитель");
    expect(result.members[0].discount_bps).toBe(3000);
  });

  it("teacher lesson list contains occupancy, but no revenue or trainer cost",async()=>{
    const {service}=harness(false,async()=>({rows:[{
      id:"lesson",booked_count:8,attended_count:6,
      earned_revenue_minor:"600000",trainer_cost_minor:"200000",
      room_cost_minor:"80000",contribution_margin_minor:"320000"
    }]}));
    const result=await service.lessons(context,{});
    expect(result[0].booked_count).toBe(8);
    expect(result[0].earned_revenue_minor).toBeNull();
    expect(result[0].trainer_cost_minor).toBeNull();
    expect(result[0].room_cost_minor).toBeNull();
    expect(result[0].contribution_margin_minor).toBeNull();
  });

  it("teacher attendance journal contains no prices or remaining package balance",async()=>{
    const {service}=harness(false,async()=>({rows:[{
      id:"participant",student_name:"Мария",
      charge_minor:"20000",currency:"RUB",
      visit_limit_snapshot:12,reserved_visits:3,used_visits:5
    }]}));
    (service as any).assertLessonAccess=jest.fn().mockResolvedValue({id:"lesson"});
    const result=await service.participants(context,"lesson");
    expect(result[0].student_name).toBe("Мария");
    for(const key of [
      "charge_minor","currency","visit_limit_snapshot","reserved_visits","used_visits"
    ])expect(result[0][key]).toBeNull();
  });
});
