import {ConflictException} from "@nestjs/common";
import {BookingService} from "./booking.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const employee="44444444-4444-4444-8444-444444444444";
const serviceId="55555555-5555-4555-8555-555555555555";
const input={
  serviceId,resourceId:employee,resourceType:"EMPLOYEE",
  from:"2026-10-13T10:00:00.000Z",to:"2026-10-13T12:00:00.000Z",
  slotStepMinutes:30
};

function fixture(hasRule:boolean){
  const queries:Array<{sql:string;args:unknown[]}>= [];
  const client={
    query:jest.fn(async(sql:string,args:unknown[]=[])=>{
      queries.push({sql,args});
      if(sql.includes("FROM service_resource r"))
        return {rows:[{id:employee,name:"Master",type:"EMPLOYEE",
          capacity:1,timezone:"Europe/Moscow"}],rowCount:1};
      if(sql.includes("FROM service_delivery_rule"))
        return {rows:hasRule?[{id:"rule"}]:[],rowCount:hasRule?1:0};
      throw new Error("Unexpected SQL: "+sql);
    })
  };
  const db={
    withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>cb(client))
  };
  const service=Object.create(BookingService.prototype) as any;
  service.database=db;
  service.serviceScope=jest.fn().mockResolvedValue(null);
  service.getService=jest.fn().mockResolvedValue({
    id:serviceId,duration_minutes:60,
    buffer_before_minutes:0,buffer_after_minutes:0,
    delivery_format:"INDIVIDUAL"
  });
  service.resourceAvailable=jest.fn().mockResolvedValue(true);
  service.resolveDeliveryRule=jest.fn().mockResolvedValue(null);
  return {service:service as BookingService,queries,client,impl:service};
}

describe("availability and employee-specific service delivery rules",()=>{
  it("filters by employee before evaluating availability",async()=>{
    const {service,queries}=fixture(false);
    const slots=await service.availability(ctx,input);
    expect(slots).toHaveLength(3);
    expect(slots.every(x=>x.resourceId===employee)).toBe(true);
    const select=queries.find(q=>q.sql.includes("FROM service_resource r"));
    expect(select?.sql).toContain("r.id = $5");
    expect(select?.args[4]).toBe(employee);
  });
  it("does not resolve rules when no rules exist",async()=>{
    const {service,impl}=fixture(false);
    await service.availability(ctx,input);
    expect(impl.resolveDeliveryRule).not.toHaveBeenCalled();
  });
  it("respects employee-specific duration before showing slots",async()=>{
    const {service,impl}=fixture(true);
    impl.resolveDeliveryRule.mockResolvedValue({duration_minutes:90});
    const slots=await service.availability(ctx,input);
    expect(slots.map(x=>x.startsAt)).toEqual([
      "2026-10-13T10:00:00.000Z",
      "2026-10-13T10:30:00.000Z"
    ]);
    expect(impl.resourceAvailable).toHaveBeenCalledWith(
      expect.anything(),ctx.tenantId,employee,
      new Date("2026-10-13T10:00:00.000Z"),
      new Date("2026-10-13T11:30:00.000Z"),0,0,1
    );
  });
  it("hides restricted employee slots, but does not conceal DB failures",async()=>{
    const {service,impl}=fixture(true);
    impl.resolveDeliveryRule.mockRejectedValueOnce(
      new ConflictException("Employee cannot provide this service")
    );
    const slots=await service.availability(ctx,input);
    expect(slots).toHaveLength(2);
    impl.resolveDeliveryRule.mockRejectedValueOnce(new Error("DB down"));
    await expect(service.availability(ctx,input)).rejects.toThrow("DB down");
  });
  it("rejects invalid employee identifiers before tenant SQL",async()=>{
    const {service,impl}=fixture(false);
    await expect(service.availability(ctx,{...input,resourceId:"not-a-uuid"}))
      .rejects.toThrow("Некорректный идентификатор");
    expect(impl.database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
