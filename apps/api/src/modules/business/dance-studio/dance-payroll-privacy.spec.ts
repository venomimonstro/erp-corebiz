import {ForbiddenException} from "@nestjs/common";
import {DanceEconomicsService} from "./dance-economics.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};

describe("dance studio: financial authorization and employee payroll",()=>{
  function build(financeRead:string|null,financeWrite:string|null){
    const client={query:jest.fn(async()=>({rows:[],rowCount:0}))};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const auth={
      resolveScope:jest.fn(async(_ctx:unknown,permission:string)=>{
        if(permission==="dance.read"||permission==="dance.write")return "all";
        if(permission==="finance.read")return financeRead;
        if(permission==="finance.write")return financeWrite;
        return null;
      }),
      membershipIdsForScope:jest.fn(async(_ctx:unknown,scope:string)=>{
        if(scope==="all")return null;
        return [
          "77777777-7777-4777-8777-777777777777"
        ];
      })
    };
    const service=new DanceEconomicsService(db as any,auth as any,{} as any);
    return {service,db,client,auth};
  }

  it("nonfinancial administrator cannot view anybody else's payroll",async()=>{
    const {service,client}=build(null,null);
    await service.payrollStatements(ctx,{from:"2026-10-01",to:"2026-11-01"});
    expect(client.query.mock.calls[0][1][3]).toEqual([ctx.membershipId]);
  });

  it("team-scoped finance manager can only read the same team",async()=>{
    const {service,client}=build("team",null);
    await service.payrollStatements(ctx,{from:"2026-10-01",to:"2026-11-01"});
    expect(client.query.mock.calls[0][1][3])
      .toEqual(["77777777-7777-4777-8777-777777777777"]);
  });

  it("team finance.write cannot create arbitrary tenant-wide charges",async()=>{
    const {service,db}=build("team","team");
    await expect(service.createCharge(ctx,"student-id",{
      amountMinor:"30000",sourceType:"OTHER"
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("teacher and scoped finance user cannot access tenant-wide rent contracts",async()=>{
    const {service,db}=build("team",null);
    await expect(service.roomContracts(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("owner cannot forge another trainer's payroll acknowledgment",async()=>{
    const {service,client}=build("all","all");
    client.query.mockResolvedValueOnce({rows:[{
      id:"payroll-id",trainer_resource_id:"trainer-id",
      total_minor:"500000",currency:"RUB",status:"FINALIZED",
      membership_id:"77777777-7777-4777-8777-777777777777"
    }],rowCount:1});
    await expect(service.reviewPayrollStatement(ctx,"payroll-id",{
      status:"ACKNOWLEDGED"
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
