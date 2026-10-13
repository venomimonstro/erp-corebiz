import {BadRequestException,ConflictException,ForbiddenException} from "@nestjs/common";
import {ResourcesService} from "./resources.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const employeeId="44444444-4444-4444-8444-444444444444";
const request={
  startDate:"2026-10-14",days:60,startsWorking:true,
  startMinute:540,endMinute:1260
};
function makeFixture(options:{scope?:string;existing?:number;different?:boolean;kind?:string}={}){
  const calls:Array<{sql:string;args:unknown[]}>= [];
  const db={
    withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))
  };
  const authorization={
    resolveScope:jest.fn(async()=>options.scope??"all")
  };
  const client={
    query:jest.fn(async(sql:string,args:unknown[]=[])=>{
      calls.push({sql,args});
      if(sql.includes("SELECT type,timezone FROM service_resource"))
        return {rows:[{type:options.kind??"EMPLOYEE",timezone:"Europe/Moscow"}],rowCount:1};
      if(sql.includes("SELECT weekday,start_minute,end_minute FROM service_resource_schedule")){
        const rows=Array.from({length:options.existing??0},(_,i)=>({
          weekday:i+1,start_minute:540,
          end_minute:options.different?1200:1260
        }));
        return {rows,rowCount:rows.length};
      }
      if(sql.includes("RETURNING id"))
        return {rows:Array(30).fill({id:"off-day"}),rowCount:30};
      return {rows:[],rowCount:0};
    })
  };
  const svc=Object.create(ResourcesService.prototype) as any;
  svc.database=db;svc.authorization=authorization;
  svc.serviceScope=jest.fn(async()=>({
    scope:options.scope??"all",membershipIds:null
  }));
  svc.audit=jest.fn(async()=>undefined);
  return {service:svc as ResourcesService,client,db,authorization,calls};
}

describe("2/2 receptionist shift materialization",()=>{
  it("creates seven normal day windows and 30 off days in Moscow for 60 days",async()=>{
    const f=makeFixture();
    const result=await f.service.twoByTwo(context,employeeId,request);
    expect(result).toEqual({
      days:60,blockedDays:30,timezone:"Europe/Moscow"
    });
    const created=f.calls.find(x=>x.sql.includes("WITH days AS"));
    expect(created?.sql).toContain("AT TIME ZONE $5");
    expect(created?.sql).toContain("COREBIZ_2X2_MANAGER_OFF");
    expect(created?.args).toEqual([
      context.tenantId,employeeId,request.startDate,60,
      "Europe/Moscow",true,context.membershipId
    ]);
    expect(f.calls.some(x=>x.sql.includes("generate_series(1,7)"))).toBe(true);
    expect(f.serviceScope).toHaveBeenCalledWith(context,"service.write");
  });
  it("replaces only generated future rota blocks, leaving vacation blocks untouched",async()=>{
    const f=makeFixture({existing:7});
    await f.service.twoByTwo(context,employeeId,request);
    const remove=f.calls.find(x=>x.sql.startsWith("DELETE FROM service_resource_block"));
    expect(remove?.sql).toContain("reason='COREBIZ_2X2_MANAGER_OFF'");
    expect(remove?.sql).toContain("starts_at>=");
    expect(remove?.sql).not.toContain("VACATION");
    expect(f.calls.some(x=>x.sql.startsWith("DELETE FROM service_resource_schedule"))).toBe(false);
  });
  it("refuses to silently destroy a manually configured week",async()=>{
    const f=makeFixture({existing:7,different:true});
    await expect(f.service.twoByTwo(context,employeeId,request))
      .rejects.toBeInstanceOf(ConflictException);
    expect(f.calls.some(x=>x.sql.startsWith("DELETE FROM service_resource_schedule"))).toBe(false);
  });
  it("requires both schedule rights and company admin rights",async()=>{
    const f=makeFixture({scope:"own"});
    await expect(f.service.twoByTwo(context,employeeId,request))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it.each([
    {days:91},{days:3},{startDate:"2026-02-30"},{startMinute:1400,endMinute:1200}
  ])("rejects malformed windows before database writes %o",async(change)=>{
    const f=makeFixture();
    await expect(f.service.twoByTwo(context,employeeId,{...request,...change}))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(f.db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("does not let a manager assign an employee rota to a rental hall",async()=>{
    const f=makeFixture({kind:"HALL"});
    await expect(f.service.twoByTwo(context,employeeId,request))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
