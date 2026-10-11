import {ForbiddenException} from "@nestjs/common";
import {ServiceWorkspaceService} from "./service-workspace.service";
import {ServiceEconomicsService} from "./service-economics.service";

const ctx={tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"};

describe("shared service verticals: finance-safe access",()=>{
  const sample={id:"booking",status:"COMPLETED",price_minor_snapshot:"180000",
    currency:"RUB"};
  function workspace(finance:boolean){
    const client={query:jest.fn(async()=>({rows:[sample],rowCount:1}))};
    const database={withTenantTransaction:jest.fn(async(_ctx:unknown,run:any)=>run(client))};
    const authorization={
      resolveScope:jest.fn(async(_ctx:unknown,permission:string)=>
        permission==="service.read"?"all":permission==="finance.read"&&finance?"all":null),
      membershipIdsForScope:jest.fn(async()=>null)
    };
    return {service:new ServiceWorkspaceService(database as any,{} as any,{} as any,authorization as any),client};
  }
  it("salon employee sees appointments but not service prices or revenue",async()=>{
    const {service}=workspace(false);
    const result=await service.today(ctx);
    expect(result.metrics.completed).toBe(1);
    expect(result.metrics.revenueMinor).toBeNull();
    expect(result.bookings[0].price_minor_snapshot).toBeNull();
    expect(result.bookings[0].currency).toBeNull();
  });
  it("salon owner with finance rights sees actual completed revenue",async()=>{
    const {service}=workspace(true);
    const result=await service.today(ctx);
    expect(result.metrics.revenueMinor).toBe("180000");
    expect(result.bookings[0].price_minor_snapshot).toBe("180000");
  });
  it("does not expose profit and payroll dashboard to barbers without finance permission",async()=>{
    const database={withTenantTransaction:jest.fn()};
    const auth={resolveScope:jest.fn(async(_ctx:unknown,permission:string)=>
      permission==="service.read"?"all":null)};
    const service=new ServiceEconomicsService(database as any,auth as any);
    await expect(service.dashboard(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("own payroll remains available without access to colleagues pay slips",async()=>{
    const auth={
      resolveScope:jest.fn(async(_ctx:unknown,p:string)=>p==="service.read"?"all":null),
      membershipIdsForScope:jest.fn(async()=>null)
    };
    const service=new ServiceEconomicsService({} as any,auth as any);
    await expect((service as any).payrollReadScope(ctx))
      .resolves.toEqual([ctx.membershipId]);
  });
  it("editing a salary plan needs explicit financial write permission",async()=>{
    const db={withTenantTransaction:jest.fn()};
    const auth={resolveScope:jest.fn(async(_ctx:unknown,p:string)=>
      p==="service.write"?"all":null)};
    const service=new ServiceEconomicsService(db as any,auth as any);
    await expect(service.createPayrollProfile(ctx,{
      employeeResourceId:"person",monthlyBaseMinor:"100000"
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });
});
