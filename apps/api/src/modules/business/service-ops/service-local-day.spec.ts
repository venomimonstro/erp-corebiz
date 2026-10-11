import {BadRequestException} from "@nestjs/common";
import {ServiceWorkspaceService} from "./service-workspace.service";

const ctx={tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"};

function fixture(){
  const query=jest.fn(async(_sql:string,_params:unknown[])=>({
    rows:[{id:"booking",status:"COMPLETED",
      venue_timezone:"Europe/Moscow",price_minor_snapshot:"25000"}],rowCount:1
  }));
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({query}))};
  const authorization={
    resolveScope:jest.fn(async(_ctx:unknown,p:string)=>p==="service.read"?"all":null),
    membershipIdsForScope:jest.fn(async()=>null)
  };
  const service=new ServiceWorkspaceService(
    db as any,{} as any,{} as any,authorization as any
  );
  return {service,db,query};
}
describe("local business day in service workplace",()=>{
  it("uses room or trainer timezone, not server-midnight UTC",async()=>{
    const {service,query}=fixture();
    const result=await service.today(ctx,"2026-10-11");
    const sql=String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("venue_tz.timezone");
    expect(sql).toContain("AT TIME ZONE");
    expect(query.mock.calls[0]?.[1]).toEqual([
      ctx.tenantId,"2026-10-11",null
    ]);
    expect(result.metrics.total).toBe(1);
    expect(result.metrics.revenueMinor).toBeNull();
    expect(result.bookings[0].price_minor_snapshot).toBeNull();
  });
  it("computes today's calendar date locally for each assigned venue",async()=>{
    const {service,query}=fixture();
    await service.today(ctx);
    expect(query.mock.calls[0]?.[1][1]).toBeNull();
  });
  it.each(["2026-02-30","2026-13-01","11.10.2026","2026-10-11T12:00:00Z"])(
    "rejects impossible and ambiguous dates (%s)",async date=>{
      const {service,db}=fixture();
      await expect(service.today(ctx,date)).rejects.toBeInstanceOf(BadRequestException);
      expect(db.withTenantTransaction).not.toHaveBeenCalled();
    }
  );
});
