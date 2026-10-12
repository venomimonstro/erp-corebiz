import {BadRequestException} from "@nestjs/common";
import {BookingService} from "./booking.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const staffId="44444444-4444-4444-8444-444444444444";

describe("service availability: staff-first filtering",()=>{
  function fixture(){
    const queries:Array<{sql:string;params:unknown[]}>=list();
    const db={
      withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>
        fn({
          query:jest.fn(async(sql:string,params:unknown[])=>{
            queries.push({sql,params});
            return {rows:[{id:staffId,name:"Employee",type:"EMPLOYEE",
              timezone:"Europe/Moscow",capacity:1}],rowCount:1};
          })
        }))
    };
    const service=Object.create(BookingService.prototype) as any;
    service.database=db;
    service.serviceScope=jest.fn().mockResolvedValue(null);
    service.getService=jest.fn().mockResolvedValue({
      duration_minutes:60,buffer_before_minutes:0,buffer_after_minutes:0
    });
    service.resourceAvailable=jest.fn().mockResolvedValue(true);
    return {service,queries,db};
  }
  function list<T>():T[]{return [];}
  const interval={
    serviceId:"55555555-5555-4555-8555-555555555555",
    from:"2026-10-14T09:00:00Z",to:"2026-10-14T12:00:00Z"
  };
  it("restricts workers in SQL before the 500-slot response limit",async()=>{
    const f=fixture();
    const result=await f.service.availability(ctx,{
      ...interval,resourceId:staffId
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((x:{resourceId:string})=>x.resourceId===staffId))
      .toBe(true);
    expect(f.queries[0].sql).toContain("r.id = $5");
    expect(f.queries[0].params[4]).toBe(staffId);
  });
  it("preserves legacy availability without resource filter",async()=>{
    const f=fixture();
    await f.service.availability(ctx,interval);
    expect(f.queries[0].params[4]).toBeNull();
  });
  it("rejects invalid resource IDs before executing tenant SQL",async()=>{
    const f=fixture();
    await expect(f.service.availability(ctx,{
      ...interval,resourceId:"unknown"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.db.withTenantTransaction).not.toHaveBeenCalled();
  });
});
